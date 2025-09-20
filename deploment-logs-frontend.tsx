import { type DeploymentLogPayload } from '@/lib/api-generated';
import { getDeploymentsLogs, getHostedFunctionsByFunctionIdTools } from '@/lib/api-generated/sdk.gen';
import { useState, useEffect, useRef, use } from 'react';
import { Badge } from '@/components/ui/badge';
import { Duration, RelativeTime } from '@/components/ui/relative-time';
import {
  CheckCircle,
  Clock,
  XCircle,
  AlertCircle,
  Container,
  Download,
  PackageOpen,
  LoaderCircle,
  Logs,
  ToolCaseIcon,
  Wrench,
} from 'lucide-react';
import { cn, getErrorMessage } from '@/lib/utils';

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
  crashLogs?: {
    stdout: string;
    stderr: string;
    isLoading: boolean;
  };
}

export function DeploymentLogs({
  hostedFunctionId,
  serverSlug,
  editorFunctionId,
  onReady,
  onCrash,
}: {
  hostedFunctionId?: string;
  serverSlug?: string;
  editorFunctionId?: string;
  onReady?: () => void;
  onCrash?: () => void;
}) {
  const [logs, setLogs] = useState<DeploymentLogPayload[]>([]);
  const [deploymentState, setDeploymentState] = useState<DeploymentState>({
    containers: {},
    errors: [],
  });
  const logSourceRef = useRef<EventSource | null>(null);
  const [isMainContainerReady, setIsMainContainerReady] = useState(false);
  const [listedTools, setListedTools] = useState<{ name: string }[] | undefined>(undefined);
  const [listedToolsLoading, setListedToolsLoading] = useState<boolean>(false);

  useEffect(() => {
    // Create EventSource only once when component mounts or functionId changes
    const query = new URLSearchParams({
      hostedFunctionId: hostedFunctionId || '',
      serverSlug: serverSlug || '',
      editorFunctionId: editorFunctionId || '',
    });
    const logSource = new EventSource(`/api/v1/deployments/deployment-logs?${query.toString()}`);
    logSourceRef.current = logSource;

    logSource.onerror = error => {
      console.error('EventSource error:', error);
      const errorLog: DeploymentLogPayload = { type: 'error', message: 'Connection error occurred' };
      setLogs(prevLogs => [...prevLogs, errorLog]);
      setDeploymentState(prev => ({
        ...prev,
        errors: [...prev.errors, 'Connection error occurred'],
      }));
    };

    logSource.addEventListener('DeploymentLogPayload', function (event) {
      console.log('event', event);
      const type = event.type;
      if (type !== 'DeploymentLogPayload') {
        const errorLog: DeploymentLogPayload = { type: 'error', message: `Unknown log type: ${type}` };
        setLogs(prevLogs => [...prevLogs, errorLog]);
        setDeploymentState(prev => ({
          ...prev,
          errors: [...prev.errors, `Unknown log type: ${type}`],
        }));
      } else {
        const newLog = JSON.parse(event.data) as DeploymentLogPayload;
        if (newLog.type === 'done') {
          logSource.close();
          logSourceRef.current = null;
          return;
        }

        setLogs(prevLogs => [...prevLogs, newLog]);

        // Update deployment state based on log type
        setDeploymentState(prev => {
          const newState = { ...prev };

          switch (newLog.type) {
            case 'podInfo':
              newState.podInfo = {
                createdAt: newLog.createdAt,
                pod: newLog.pod,
                initContainers: newLog.initContainers,
                containers: newLog.containers,
              };

              // Initialize all containers as pending
              newLog.initContainers.forEach(name => {
                newState.containers[name] = {
                  name,
                  type: 'init',
                  status: 'pending',
                };
              });

              newLog.containers.forEach(name => {
                newState.containers[name] = {
                  name,
                  type: 'main',
                  status: 'pending',
                };
              });
              break;

            case 'initContainerRunning':
              if (newState.containers[newLog.name]) {
                newState.containers[newLog.name] = {
                  ...newState.containers[newLog.name],
                  status: 'running',
                };
              }
              break;

            case 'initContainerTerminated':
              if (newState.containers[newLog.name]) {
                newState.containers[newLog.name] = {
                  ...newState.containers[newLog.name],
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
              Object.keys(newState.containers).forEach(name => {
                if (newState.containers[name].type === 'main') {
                  newState.containers[name] = {
                    ...newState.containers[name],
                    status: 'running',
                  };
                }
              });
              break;

            case 'mainContainerReady':
              // Find the main container and mark it as completed (ready means successfully running)
              Object.keys(newState.containers).forEach(name => {
                if (newState.containers[name].type === 'main') {
                  newState.containers[name] = {
                    ...newState.containers[name],
                    status: 'ready',
                  };
                }
              });
              onReady?.(); // let parent know
              setIsMainContainerReady(true);
              break;

            case 'mainContainerCrashed':
              // Find the main container and mark it as failed
              Object.keys(newState.containers).forEach(name => {
                if (newState.containers[name].type === 'main') {
                  newState.containers[name] = {
                    ...newState.containers[name],
                    status: 'failed',
                    startedAt: newLog.startedAt,
                    finishedAt: newLog.finishedAt,
                    exitCode: newLog.exitCode,
                    reason: newLog.reason,
                  };
                }
              });
              onCrash?.(); // let parent know

              // Fetch crash logs if we have pod info
              if (newState.podInfo) {
                // Use setTimeout to avoid calling async function in setState
                setTimeout(() => {
                  fetchCrashLogs(newState.podInfo!.pod);
                }, 0);
              }
              break;

            case 'error':
              newState.errors = [...newState.errors, newLog.message];
              break;
          }

          return newState;
        });
      }
    });

    logSource.onerror = function (error) {
      console.error('EventSource error:', error);
      const errorLog: DeploymentLogPayload = { type: 'error', message: 'Connection error occurred' };
      setLogs(prevLogs => [...prevLogs, errorLog]);
      setDeploymentState(prev => ({
        ...prev,
        errors: [...prev.errors, 'Connection error occurred'],
      }));
    };

    // Cleanup function to close EventSource when component unmounts or functionId changes
    return () => {
      logSource.close();
      logSourceRef.current = null;
    };
  }, [hostedFunctionId]); // Re-create EventSource if functionId changes

  useEffect(() => {
    // If main container is ready and we haven't listed tools yet, do so
    if (
      isMainContainerReady &&
      hostedFunctionId &&
      deploymentState.podInfo &&
      listedTools === undefined &&
      !listedToolsLoading
    ) {
      setListedToolsLoading(true);
      (async () => {
        try {
          const toolsResponse = await getHostedFunctionsByFunctionIdTools({
            path: { functionId: hostedFunctionId },
            query: { podName: deploymentState.podInfo!.pod },
          });

          if (toolsResponse.error) {
            const errorMessage = `Failed to list tools: ${getErrorMessage(toolsResponse.error)}`;
            console.error('Error listing tools:', getErrorMessage(toolsResponse.error));
            setListedTools([]);
            setDeploymentState(prev => ({
              ...prev,
              errors: [...prev.errors, errorMessage],
            }));
          } else if (toolsResponse.data) {
            const tools = toolsResponse.data.tools || [];
            setListedTools(tools);
          } else {
            setListedTools([]);
          }
        } catch (error) {
          const errorMessage = `Failed to fetch tools: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error('Error fetching tools:', error);
          setListedTools([]);
          setDeploymentState(prev => ({
            ...prev,
            errors: [...prev.errors, errorMessage],
          }));
        } finally {
          setListedToolsLoading(false);
        }
      })();
    }
  }, [isMainContainerReady, hostedFunctionId, deploymentState, listedTools, listedToolsLoading]);

  const fetchCrashLogs = async (podName: string) => {
    setDeploymentState(prev => ({
      ...prev,
      crashLogs: { stdout: '', stderr: '', isLoading: true },
    }));

    const maxRetries = 50; // 50 retries * 100ms = 5 seconds max
    let retryCount = 0;

    const attemptFetch = async (): Promise<void> => {
      try {
        const response = await getDeploymentsLogs({
          query: { podName },
        });

        if (response.error) {
          setDeploymentState(prev => ({
            ...prev,
            crashLogs: { stdout: '', stderr: '', isLoading: false },
            errors: [...prev.errors, `Failed to fetch crash logs: ${getErrorMessage(response.error)}`],
          }));
          return;
        }

        if (response.data) {
          const { stdout, stderr } = response.data.logs;

          // If stdout is empty and we haven't exceeded max retries, wait and try again
          if (!stdout && retryCount < maxRetries) {
            retryCount++;
            setTimeout(() => {
              attemptFetch();
            }, 100);
            return;
          }

          // We have logs or exceeded max retries, update state
          setDeploymentState(prev => ({
            ...prev,
            crashLogs: {
              stdout,
              stderr,
              isLoading: false,
            },
          }));
        }
      } catch (error) {
        console.error('Error fetching crash logs:', error);
        setDeploymentState(prev => ({
          ...prev,
          crashLogs: { stdout: '', stderr: '', isLoading: false },
          errors: [...prev.errors, 'Failed to fetch crash logs'],
        }));
      }
    };

    attemptFetch();
  };

  const getStatusIcon = (status: ContainerStatus) => {
    switch (status) {
      case 'pending':
        return <Clock className="h-4 w-4 text-gray-400" />;
      case 'running':
        return <LoaderCircle className="h-4 w-4 text-blue-500 animate-spin" />;
      case 'completed':
      case 'ready':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-red-500" />;
    }
  };

  const getStatusBadge = (status: ContainerStatus) => {
    switch (status) {
      case 'pending':
        return <Badge variant="secondary">Pending</Badge>;
      case 'running':
        return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Starting</Badge>;
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'failed':
        return <Badge variant="destructive">Failed</Badge>;
      case 'ready':
        return <Badge variant="success">Ready</Badge>;
    }
  };

  const ContainerStatusItem = ({ container }: { container: ContainerState }) => (
    <div className="flex items-center justify-between p-3 border rounded-lg">
      <div className="flex items-center gap-3">
        {getStatusIcon(container.status)}
        <div className="flex items-center gap-2">
          {container.name === 'download' ? (
            <Download className="h-4 w-4 text-gray-500" />
          ) : container.name === 'unzip' ? (
            <PackageOpen className="h-4 w-4 text-gray-500" />
          ) : (
            <Container className="h-4 w-4 text-gray-500" />
          )}
          <span className="font-medium">{container.name}</span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {getStatusBadge(container.status)}
        {container.exitCode !== undefined && container.exitCode !== 0 && (
          <span
            className={cn(
              'text-sm font-mono px-2 py-1 rounded',
              container.exitCode === 0 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
            )}
          >
            Exit: {container.exitCode}
          </span>
        )}

        {container.finishedAt && (
          <Duration from={container.startedAt} to={container.finishedAt} className="text-sm text-gray-500" />
        )}
        {!container.finishedAt && container.startedAt && (
          <RelativeTime date={container.startedAt} prefix="since" addSuffix={false} className="text-sm text-gray-500" />
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Pod Information */}
      {deploymentState.podInfo && (
        <div className="border rounded-lg p-4 bg-gray-50">
          <div className="flex items-center gap-2 mb-3">
            <Container className="h-5 w-5 text-gray-600" />
            <h3 className="font-semibold">Deployment</h3>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Name:</span>
              <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{deploymentState.podInfo.pod}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Created:</span>
              <RelativeTime date={deploymentState.podInfo.createdAt} />
            </div>
          </div>
        </div>
      )}

      {/* Container Timeline */}
      {Object.keys(deploymentState.containers).length > 0 && (
        <div className="space-y-4">
          {/* Init Containers */}
          {deploymentState.podInfo?.initContainers && deploymentState.podInfo.initContainers.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-gray-700">Initialization</h4>
              {deploymentState.podInfo.initContainers.map(
                name =>
                  deploymentState.containers[name] && (
                    <ContainerStatusItem key={name} container={deploymentState.containers[name]} />
                  )
              )}
            </div>
          )}

          {/* Main Containers */}
          {deploymentState.podInfo?.containers && deploymentState.podInfo.containers.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-gray-700">Application</h4>
              {deploymentState.podInfo.containers.map(
                name =>
                  deploymentState.containers[name] && (
                    <ContainerStatusItem key={name} container={deploymentState.containers[name]} />
                  )
              )}
            </div>
          )}
        </div>
      )}

      {/* Error Messages */}
      {deploymentState.errors.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-red-700">Errors</h4>
          {deploymentState.errors.map((error, index) => (
            <div key={index} className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-red-500 flex-shrink-0" />
              <span className="text-red-800 text-sm">{error}</span>
            </div>
          ))}
        </div>
      )}

      {/* Crash Logs */}
      {deploymentState.crashLogs && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Logs className="h-5 w-5 text-red-500" />
            <h4 className="font-medium text-red-700">Container Logs</h4>
            {deploymentState.crashLogs.isLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-500" />}
          </div>

          {deploymentState.crashLogs.isLoading && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <LoaderCircle className="h-4 w-4 animate-spin text-blue-500 flex-shrink-0" />
              <span className="text-blue-800 text-sm">Waiting for logs...</span>
            </div>
          )}

          {!deploymentState.crashLogs.isLoading &&
            (deploymentState.crashLogs.stdout || deploymentState.crashLogs.stderr) && (
              <div className="space-y-3">
                {deploymentState.crashLogs.stdout && (
                  <div className="space-y-2">
                    <div className="bg-gray-50 border rounded-lg p-3 font-mono text-xs whitespace-pre-wrap max-h-96 overflow-y-auto">
                      {deploymentState.crashLogs.stdout}
                    </div>
                  </div>
                )}

                {deploymentState.crashLogs.stderr && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-red-700">stderr:</span>
                    </div>
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 font-mono text-sm whitespace-pre-wrap max-h-96 overflow-y-auto text-red-900">
                      {deploymentState.crashLogs.stderr}
                    </div>
                  </div>
                )}
              </div>
            )}

          {!deploymentState.crashLogs.isLoading &&
            !deploymentState.crashLogs.stdout &&
            !deploymentState.crashLogs.stderr && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
                No logs available for this container crash.
              </div>
            )}
        </div>
      )}

      {/* If hosted function: call list tools*/}
      {hostedFunctionId && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-gray-700">Tools</h4>
            {listedToolsLoading && <LoaderCircle className="h-4 w-4 animate-spin text-gray-500" />}
          </div>

          {!isMainContainerReady && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <Clock className="h-4 w-4 text-blue-500 flex-shrink-0" />
              <span className="text-blue-800 text-sm">Waiting for main container to be ready...</span>
            </div>
          )}

          {listedToolsLoading && isMainContainerReady && (
            <div className="flex items-center gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <LoaderCircle className="h-4 w-4 animate-spin text-blue-500 flex-shrink-0" />
              <span className="text-blue-800 text-sm">Loading tools...</span>
            </div>
          )}

          {!listedToolsLoading && listedTools !== undefined && (
            <div className="space-y-2">
              {listedTools.length > 0 ? (
                <div className="grid gap-2">
                  {listedTools.map((tool, index) => (
                    <div key={index} className="flex items-center gap-3 p-3 border rounded-lg">
                      <CheckCircle className="h-4 w-4 text-green-500 flex-shrink-0" />
                      <Wrench className="h-4 w-4 flex-shrink-0" />
                      <span className="font-medium">{tool.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
                  No tools available
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Fallback: If no pod info yet, show raw logs */}
      {!deploymentState.podInfo && logs.length > 0 && (
        <div className="space-y-2">
          <h4 className="font-medium text-gray-700">Raw Deployment Logs</h4>
          {logs.map((log, index) => (
            <div
              key={index}
              className={cn(
                'p-3 rounded-lg font-mono text-sm whitespace-pre-wrap',
                log.type === 'error'
                  ? 'bg-red-50 border border-red-200 text-red-800'
                  : 'bg-gray-50 border border-gray-200'
              )}
            >
              {JSON.stringify(log, null, 2)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
