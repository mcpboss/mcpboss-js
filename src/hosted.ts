import { confirm, input } from '@inquirer/prompts';
import { existsSync, createReadStream, readFileSync } from 'fs';
import { join } from 'path';
import archiver from 'archiver';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { McpBoss, loadConfig } from '../lib/index.js';
import { HostedToolFunction, DeploymentLogPayload } from '../lib/api/types.gen.js';
import { EventSource } from 'eventsource';
import { formDataBodySerializer } from '../lib/api/core/bodySerializer.gen.js';
import { output, outputError, outputInfo } from './output.js';

export interface HostedFunctionInfo {
  id: string;
  name: string;
}

export interface HostedFunctionListItem {
  id: string;
  name: string;
  age: string;
  isEnabled: boolean;
}

/**
 * Helper function to convert error objects to readable error messages
 */
export function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object') {
    // Check for common error properties
    if ('message' in error && typeof error.message === 'string') {
      return error.message;
    }

    // Try to extract useful information from the error object
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

export async function promptForNewFunction(): Promise<{ create: boolean; name?: string }> {
  const create = await confirm({
    message: 'No hosted tool ID provided. Would you like to create a new hosted tool?',
    default: true,
  });

  if (!create) {
    return { create: false };
  }

  const name = await input({
    message: 'Enter the name for the new hosted tool:',
    validate: input => {
      if (!input.trim()) {
        return 'Function name is required';
      }
      if (input.length < 3) {
        return 'Function name must be at least 3 characters long';
      }
      return true;
    },
  });

  return { create: true, name: name.trim() };
}

export function checkIndexJsExists(currentDir: string = process.cwd()): {
  exists: boolean;
  hasSchema: boolean;
  error?: string;
} {
  const indexPath = join(currentDir, 'index.js');

  if (!existsSync(indexPath)) {
    return { exists: false, hasSchema: false, error: 'index.js file not found' };
  }

  try {
    const content = readFileSync(indexPath, 'utf8');

    // Check for schema export patterns
    const hasEsModuleSchema = /export\s+const\s+schema\s*=/i.test(content);
    const hasCommonJsSchema = /module\.exports\.schema\s*=/i.test(content);
    const hasSchema = hasEsModuleSchema || hasCommonJsSchema;

    return {
      exists: true,
      hasSchema,
      error: hasSchema
        ? undefined
        : 'index.js must export a schema (either "export const schema" or "module.exports.schema")',
    };
  } catch (error) {
    return {
      exists: true,
      hasSchema: false,
      error: `Failed to read index.js: ${getErrorMessage(error)}`,
    };
  }
}

export async function createZipFromDirectory(sourceDir: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const zipFileName = `hosted-function-${randomUUID()}.zip`;
    const zipPath = join(tmpdir(), zipFileName);

    const output = createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }, // Maximum compression
    });

    output.on('close', () => {
      resolve(zipPath);
    });

    archive.on('error', err => {
      reject(err);
    });

    archive.pipe(output);

    // Add all files from the current directory, excluding common ignore patterns
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ['.git/**', '.gitignore', '*.zip', '.DS_Store', 'Thumbs.db'],
    });

    archive.finalize();
  });
}

export async function createHostedFunction(
  mcpBoss: McpBoss,
  name: string,
  description?: string
): Promise<HostedFunctionInfo> {
  const { data, error } = await mcpBoss.api.postHostedFunctions({
    body: {
      name,
      description: description || `Hosted function ${name}`,
      runtime: 'node24',
    },
  });

  if (error) {
    throw new Error(`Failed to create hosted tool: ${getErrorMessage(error)}`);
  }

  if (!data?.function) {
    throw new Error('Failed to create hosted tool: No function data returned');
  }

  return {
    id: data.function.id,
    name: data.function.name,
  };
}

export async function uploadZipToFunction(mcpBoss: McpBoss, functionId: string, zipPath: string): Promise<void> {
  // Read the zip file as a buffer
  const fs = await import('fs/promises');
  const fileBuffer = await fs.readFile(zipPath);

  // Create a FormData object
  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(fileBuffer)]), 'function.zip');

  const config = loadConfig();
  const uploadResponse = await fetch(`${config.baseUrl}/hosted-functions/${functionId}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok || uploadResponse.status !== 200) {
    throw new Error(`Failed to upload ZIP file: ${getErrorMessage(await uploadResponse.json())}`);
  }
}

export async function startHostedFunction(mcpBoss: McpBoss, functionId: string): Promise<void> {
  const { error } = await mcpBoss.api.postHostedFunctionsByFunctionIdStart({
    path: { functionId },
  });

  if (error) {
    throw new Error(`Failed to start hosted tool: ${getErrorMessage(error)}`);
  }
}

export async function fetchCrashLogs(
  mcpBoss: McpBoss,
  podName: string
): Promise<{ stdout: string; stderr: string } | null> {
  const maxRetries = 50; // 50 retries * 100ms = 5 seconds max
  let retryCount = 0;

  const attemptFetch = async (): Promise<{ stdout: string; stderr: string } | null> => {
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const { data, error } = await mcpBoss.api.getDeploymentsLogs({
        query: { podName, previous: 'true' },
      });

      if (error) {
        console.error(`Failed to fetch crash logs: ${getErrorMessage(error)}`);
        return null;
      }

      if (data && data.logs) {
        const { stdout, stderr } = data.logs;

        // If stdout is empty and we haven't exceeded max retries, wait and try again
        if (!stdout && retryCount < maxRetries) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 200));
          return attemptFetch();
        }

        return { stdout, stderr };
      }

      return null;
    } catch (error) {
      console.error(`Error fetching crash logs: ${getErrorMessage(error)}`);
      return null;
    }
  };

  return attemptFetch();
}

type ContainerStatus = 'pending' | 'running' | 'completed' | 'failed' | 'ready' | 'crashBackOff';

interface ContainerState {
  name: string;
  type: 'init' | 'main';
  status: ContainerStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reason?: string;
  restarts?: number;
}

interface DeploymentState {
  podInfo?: {
    createdAt: string;
    pod: string;
    initContainers: string[];
    containers: string[];
  };
  containers: Record<string, ContainerState>;
  errors: string[];
  isComplete: boolean;
  isReady: boolean;
  hasCrashed: boolean;
}

export async function showDeploymentProgress(
  mcpBoss: McpBoss,
  functionId: string,
  follow: boolean
): Promise<{
  deployed: boolean;
  stabilized: boolean;
  podName?: string;
}> {
  return new Promise((resolve, reject) => {
    const deploymentState: DeploymentState = {
      containers: {},
      errors: [],
      isComplete: false,
      isReady: false,
      hasCrashed: false,
    };

    // Get the configuration
    const config = loadConfig();

    // Create EventSource URL with query parameter
    const eventSourceUrl = `${config.baseUrl}/deployments/deployment-logs?hostedFunctionId=${functionId}`;

    outputInfo('Deployment progress...');

    const eventSource = new EventSource(eventSourceUrl, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${config.apiKey}`,
          },
        }),
    });

    const getStatusIcon = (status: ContainerStatus): string => {
      switch (status) {
        case 'pending':
          return '⏳';
        case 'running':
          return '🔄';
        case 'completed':
        case 'ready':
          return '✅';
        case 'failed':
          return '❌';
        case 'crashBackOff':
          return '🔄';
      }
    };

    const printCurrentState = () => {
      console.clear();
      outputInfo('Deployment progress...');
      let toLog: Record<string, any> = {};
      if (deploymentState.podInfo) {
        toLog.deploymentId = deploymentState.podInfo.pod;

        toLog.init = [];
        if (deploymentState.podInfo.initContainers.length > 0) {
          deploymentState.podInfo.initContainers.forEach(name => {
            if (deploymentState.containers[name]) {
              const container = deploymentState.containers[name];
              const logEntry: any = {
                name: container.name,
                status: container.status,
              };
              if (container.exitCode !== undefined) logEntry.exitCode = container.exitCode;
              if (container.reason) logEntry.reason = container.reason;
              if (container.restarts !== undefined && container.restarts > 0) logEntry.restarts = container.restarts;
              toLog.init.push(logEntry);
            }
          });
        }

        toLog.app = [];
        if (deploymentState.podInfo.containers.length > 0) {
          deploymentState.podInfo.containers.forEach(name => {
            if (deploymentState.containers[name]) {
              const container = deploymentState.containers[name];
              const logEntry: any = {
                name: container.name,
                status: container.status,
              };
              if (container.exitCode !== undefined) logEntry.exitCode = container.exitCode;
              if (container.reason) logEntry.reason = container.reason;
              if (container.restarts !== undefined && container.restarts > 0) logEntry.restarts = container.restarts;
              toLog.app.push(logEntry);
            }
          });
        }
      }

      if (deploymentState.errors.length > 0) {
        deploymentState.errors.forEach(error => {
          outputError(error);
        });
      }

      output(toLog);
    };

    eventSource.addEventListener('DeploymentLogPayload', (event: any) => {
      try {
        const newLog = JSON.parse(event.data) as DeploymentLogPayload;

        if (newLog.type === 'done') {
          deploymentState.isComplete = true;
          eventSource.close();
          printCurrentState();

          // Check if deployment crashed before resolving
          if (deploymentState.hasCrashed) {
            resolve({
              deployed: true,
              stabilized: false,
              podName: deploymentState.podInfo?.pod,
            });
          } else {
            resolve({
              deployed: true,
              stabilized: true,
              podName: deploymentState.podInfo?.pod,
            });
          }
          return;
        }

        // Update deployment state based on log type
        switch (newLog.type) {
          case 'podInfo':
            deploymentState.podInfo = {
              createdAt: newLog.createdAt,
              pod: newLog.pod,
              initContainers: newLog.initContainers,
              containers: newLog.containers,
            };

            // Initialize all containers as pending
            newLog.initContainers.forEach(name => {
              deploymentState.containers[name] = {
                name,
                type: 'init',
                status: 'pending',
              };
            });

            newLog.containers.forEach(name => {
              deploymentState.containers[name] = {
                name,
                type: 'main',
                status: 'pending',
              };
            });
            break;

          case 'initContainerRunning':
            if (deploymentState.containers[newLog.name]) {
              deploymentState.containers[newLog.name] = {
                ...deploymentState.containers[newLog.name],
                status: 'running',
              };
            }
            break;

          case 'initContainerTerminated':
            if (deploymentState.containers[newLog.name]) {
              deploymentState.containers[newLog.name] = {
                ...deploymentState.containers[newLog.name],
                status: newLog.exitCode === 0 ? 'completed' : 'failed',
                startedAt: newLog.startedAt,
                finishedAt: newLog.finishedAt,
                exitCode: newLog.exitCode,
                reason: newLog.reason,
              };
            }
            break;

          case 'mainContainerRunning':
            // Find the main container and mark it as running
            Object.keys(deploymentState.containers).forEach(name => {
              if (deploymentState.containers[name].type === 'main') {
                deploymentState.containers[name] = {
                  ...deploymentState.containers[name],
                  status: 'running',
                };
              }
            });
            break;

          case 'mainContainerReady':
            // Find the main container and mark it as ready
            Object.keys(deploymentState.containers).forEach(name => {
              if (deploymentState.containers[name].type === 'main') {
                deploymentState.containers[name] = {
                  ...deploymentState.containers[name],
                  status: 'ready',
                };
              }
            });
            deploymentState.isReady = true;

            // If not following, close the connection and resolve immediately
            if (!follow) {
              eventSource.close();
              printCurrentState();
              resolve({
                deployed: true,
                stabilized: true,
                podName: deploymentState.podInfo?.pod,
              });
              return;
            }
            break;

          case 'mainContainerCrashed':
            // Find the main container and mark it as failed
            Object.keys(deploymentState.containers).forEach(name => {
              if (deploymentState.containers[name].type === 'main') {
                deploymentState.containers[name] = {
                  ...deploymentState.containers[name],
                  status: 'failed',
                  startedAt: newLog.startedAt,
                  finishedAt: newLog.finishedAt,
                  exitCode: newLog.exitCode,
                  reason: newLog.reason,
                };
              }
            });
            deploymentState.hasCrashed = true;

            // If not following, close and return failed status immediately
            if (!follow) {
              eventSource.close();
              printCurrentState();
              resolve({
                deployed: true,
                stabilized: false,
                podName: deploymentState.podInfo?.pod,
              });
              return;
            }
            break;

          case 'error':
            deploymentState.errors.push(newLog.message);
            break;

          default:
            // Handle new message types like mainContainerCrashBackOff
            if ((newLog as any).type === 'mainContainerCrashBackOff') {
              // Find the main container and mark it as crash back off
              Object.keys(deploymentState.containers).forEach(name => {
                if (deploymentState.containers[name].type === 'main') {
                  deploymentState.containers[name] = {
                    ...deploymentState.containers[name],
                    status: 'crashBackOff',
                    reason: (newLog as any).reason,
                    restarts: (newLog as any).restarts,
                  };
                }
              });
            }
            break;
        }

        printCurrentState();

        // If ready and following, resolve successfully
        // If ready and not following, we already resolved in the mainContainerReady case
        if (deploymentState.isReady && follow) {
          eventSource.close();
          resolve({
            deployed: true,
            stabilized: true,
            podName: deploymentState.podInfo?.pod,
          });
        }

        // If crashed and following, return failed status instead of rejecting
        // If crashed and not following, we already handled this in the mainContainerCrashed case
        if (deploymentState.hasCrashed && follow) {
          eventSource.close();
          resolve({
            deployed: true,
            stabilized: false,
            podName: deploymentState.podInfo?.pod,
          });
        }
      } catch (error) {
        console.error('Error parsing deployment log:', error);
        deploymentState.errors.push('Failed to parse deployment log');
        printCurrentState();
        eventSource.close();
        resolve({
          deployed: false,
          stabilized: false,
          podName: deploymentState.podInfo?.pod,
        });
      }
    });

    eventSource.onerror = (error: any) => {
      console.error('EventSource error:', error);
      deploymentState.errors.push('Connection error occurred');
      printCurrentState();
      eventSource.close();
      resolve({
        deployed: false,
        stabilized: false,
        podName: deploymentState.podInfo?.pod,
      });
    };

    // Timeout after 5 minutes
    setTimeout(
      () => {
        if (!deploymentState.isComplete) {
          eventSource.close();
          resolve({
            deployed: false,
            stabilized: false,
            podName: deploymentState.podInfo?.pod,
          });
        }
      },
      5 * 60 * 1000
    );
  });
}

export async function listHostedFunctions(mcpBoss: McpBoss): Promise<HostedToolFunction[]> {
  const { data, error } = await mcpBoss.api.getHostedFunctions();

  if (error) {
    throw new Error(`Failed to list hosted tools: ${getErrorMessage(error)}`);
  }

  return data?.functions || [];
}

export async function getHostedFunction(mcpBoss: McpBoss, functionId: string): Promise<HostedToolFunction> {
  const { data, error } = await mcpBoss.api.getHostedFunctionsByFunctionId({
    path: { functionId },
  });

  if (error) {
    throw new Error(`Failed to get hosted tool: ${getErrorMessage(error)}`);
  }

  if (!data?.function) {
    throw new Error(`Hosted function with ID ${functionId} not found`);
  }

  return data.function;
}

export async function cleanupZipFile(zipPath: string): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.unlink(zipPath);
  } catch (error) {
    console.warn(`Warning: Could not clean up temporary ZIP file: ${zipPath}`);
  }
}
