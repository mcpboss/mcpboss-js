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
    message: 'No hosted function ID provided. Would you like to create a new hosted function?',
    default: true,
  });

  if (!create) {
    return { create: false };
  }

  const name = await input({
    message: 'Enter the name for the new hosted function:',
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
    throw new Error(`Failed to create hosted function: ${getErrorMessage(error)}`);
  }

  if (!data?.function) {
    throw new Error('Failed to create hosted function: No function data returned');
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

  console.log('✅ ZIP file uploaded successfully');
}

export async function startHostedFunction(mcpBoss: McpBoss, functionId: string): Promise<void> {
  const { error } = await mcpBoss.api.postHostedFunctionsByFunctionIdStart({
    path: { functionId },
  });

  if (error) {
    throw new Error(`Failed to start hosted function: ${getErrorMessage(error)}`);
  }

  console.log('✅ Hosted function started successfully');
}

async function fetchCrashLogs(mcpBoss: McpBoss, podName: string): Promise<{ stdout: string; stderr: string } | null> {
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

type ContainerStatus = 'pending' | 'running' | 'completed' | 'failed' | 'ready';

interface ContainerState {
  name: string;
  type: 'init' | 'main';
  status: ContainerStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  reason?: string;
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
  crashLogs?: {
    stdout: string;
    stderr: string;
  };
}

export async function showDeploymentProgress(mcpBoss: McpBoss, functionId: string): Promise<void> {
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

    console.log('📦 Monitoring deployment progress...\n');

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
      }
    };

    const printContainerStatus = (container: ContainerState) => {
      const icon = getStatusIcon(container.status);
      const statusText = container.status.charAt(0).toUpperCase() + container.status.slice(1);
      const exitCodeText =
        container.exitCode !== undefined && container.exitCode !== 0 ? ` (exit ${container.exitCode})` : '';
      console.log(`  ${icon} ${container.name}: ${statusText}${exitCodeText}`);
    };

    const printCurrentState = () => {
      console.clear();
      console.log('📦 Deployment Progress\n');

      if (deploymentState.podInfo) {
        console.log(`🏷️  Pod: ${deploymentState.podInfo.pod}\n`);

        if (deploymentState.podInfo.initContainers.length > 0) {
          console.log('🔧 Initialization:');
          deploymentState.podInfo.initContainers.forEach(name => {
            if (deploymentState.containers[name]) {
              printContainerStatus(deploymentState.containers[name]);
            }
          });
          console.log('');
        }

        if (deploymentState.podInfo.containers.length > 0) {
          console.log('🚀 Application:');
          deploymentState.podInfo.containers.forEach(name => {
            if (deploymentState.containers[name]) {
              printContainerStatus(deploymentState.containers[name]);
            }
          });
          console.log('');
        }
      }

      if (deploymentState.errors.length > 0) {
        console.log('❌ Errors:');
        deploymentState.errors.forEach(error => {
          console.log(`  • ${error}`);
        });
        console.log('');
      }

      if (deploymentState.isReady) {
        console.log('🎉 Deployment completed successfully! Function is ready to use.');
      } else if (deploymentState.hasCrashed) {
        console.log('💥 Deployment failed! Check the logs for more details.');
      }

      // Display crash logs if available
      if (deploymentState.crashLogs) {
        console.log('📋 Container Logs:');
        console.log(deploymentState.crashLogs.stdout);
        if (deploymentState.crashLogs.stdout) {
          console.log('   📤 stdout:');
          console.log('   ┌─────────────────────────────────────────────────');
          deploymentState.crashLogs.stdout
            .trim()
            .split('\n')
            .forEach(line => {
              console.log(`   │ ${line}`);
            });
          console.log('   └─────────────────────────────────────────────────');
          console.log('');
        }

        if (deploymentState.crashLogs.stderr) {
          console.log('   🚨 stderr:');
          console.log('   ┌─────────────────────────────────────────────────');
          deploymentState.crashLogs.stderr
            .trim()
            .split('\n')
            .forEach(line => {
              console.log(`   │ ${line}`);
            });
          console.log('   └─────────────────────────────────────────────────');
          console.log('');
        }

        if (!deploymentState.crashLogs.stdout && !deploymentState.crashLogs.stderr) {
          console.log('   📄 No logs available for this container crash.');
          console.log('');
        }
      }
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
            // Give some time for crash logs to be fetched (up to 2 seconds)
            setTimeout(() => {
              const mainContainer = Object.values(deploymentState.containers).find(c => c.type === 'main');
              const errorMessage = mainContainer?.reason
                ? `Deployment failed - main container crashed: ${mainContainer.reason} (exit code: ${mainContainer.exitCode})`
                : `Deployment failed - main container crashed (exit code: ${mainContainer?.exitCode || 'unknown'})`;
              reject(new Error(errorMessage));
            }, 2000);
          } else {
            resolve();
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

            // Fetch crash logs if we have pod info
            if (deploymentState.podInfo) {
              console.log('\n🔍 Fetching crash logs...');
              fetchCrashLogs(mcpBoss, deploymentState.podInfo.pod)
                .then(logs => {
                  if (logs) {
                    deploymentState.crashLogs = logs;
                    console.log('✅ Crash logs fetched');
                    printCurrentState();
                  } else {
                    console.log('⚠️  No crash logs available');
                  }
                })
                .catch(error => {
                  console.error(`❌ Failed to fetch crash logs: ${getErrorMessage(error)}`);
                });
            }
            break;

          case 'error':
            deploymentState.errors.push(newLog.message);
            break;
        }

        printCurrentState();

        // If ready, resolve successfully
        if (deploymentState.isReady) {
          eventSource.close();
          resolve();
        }

        // If crashed, wait a moment for logs then reject with error
        if (deploymentState.hasCrashed) {
          eventSource.close();

          // Give some time for crash logs to be fetched (up to 2 seconds)
          setTimeout(() => {
            const mainContainer = Object.values(deploymentState.containers).find(c => c.type === 'main');
            const errorMessage = mainContainer?.reason
              ? `Deployment failed - main container crashed: ${mainContainer.reason} (exit code: ${mainContainer.exitCode})`
              : `Deployment failed - main container crashed (exit code: ${mainContainer?.exitCode || 'unknown'})`;
            reject(new Error(errorMessage));
          }, 2000);
        }
      } catch (error) {
        console.error('Error parsing deployment log:', error);
        deploymentState.errors.push('Failed to parse deployment log');
        printCurrentState();
      }
    });

    eventSource.onerror = (error: any) => {
      console.error('EventSource error:', error);
      deploymentState.errors.push('Connection error occurred');
      printCurrentState();
      eventSource.close();
      reject(new Error('Failed to monitor deployment progress'));
    };

    // Timeout after 5 minutes
    setTimeout(
      () => {
        if (!deploymentState.isComplete) {
          eventSource.close();
          reject(new Error('Deployment monitoring timed out after 5 minutes'));
        }
      },
      5 * 60 * 1000
    );
  });
}

export async function listHostedFunctions(mcpBoss: McpBoss): Promise<HostedToolFunction[]> {
  const { data, error } = await mcpBoss.api.getHostedFunctions();

  if (error) {
    throw new Error(`Failed to list hosted functions: ${getErrorMessage(error)}`);
  }

  return data?.functions || [];
}

export async function cleanupZipFile(zipPath: string): Promise<void> {
  try {
    const fs = await import('fs/promises');
    await fs.unlink(zipPath);
  } catch (error) {
    console.warn(`Warning: Could not clean up temporary ZIP file: ${zipPath}`);
  }
}
