export type OutputFormat = 'json' | 'yaml' | 'table';

import { Table } from 'console-table-printer';
import _ from 'lodash';

export interface TableColumn {
  name: string;
  title?: string;
  alignment?: 'left' | 'center' | 'right';
}

interface OutputOptions {
  format: OutputFormat;
  interactive: boolean;
}

let globalOptions: OutputOptions = {
  format: 'table',
  interactive: true,
};

export function setOutputOptions(options: Partial<OutputOptions>) {
  globalOptions = { ...globalOptions, ...options };
}

export function getOutputOptions(): OutputOptions {
  return globalOptions;
}

export function output(
  data: any,
  options?: {
    error?: boolean;
    headers?: string[];
    tableColumns?: TableColumn[];
  }
) {
  const { format, interactive } = globalOptions;
  const isError = options?.error ?? false;

  // For errors in non-interactive mode, always use stderr
  const writeFn = isError && !interactive ? console.error : console.log;

  switch (format) {
    case 'json':
      if (isError && !interactive) {
        // In non-interactive mode, errors go to stderr as JSON
        console.error(JSON.stringify({ error: data }));
      } else {
        writeFn(JSON.stringify(data));
      }
      break;

    case 'yaml':
      try {
        // Import js-yaml dynamically to handle cases where it's not installed
        const yaml = require('js-yaml');
        if (isError && !interactive) {
          console.error(yaml.dump({ error: data }));
        } else {
          writeFn(yaml.dump(data));
        }
      } catch (error) {
        // Fallback to JSON if js-yaml is not available
        console.error('YAML output requires js-yaml package. Install with: npm install js-yaml');
        if (isError && !interactive) {
          console.error(JSON.stringify({ error: data }, null, 2));
        } else {
          writeFn(JSON.stringify(data, null, 2));
        }
      }
      break;

    case 'table':
    default:
      try {
        if (Array.isArray(data) && data.length > 0) {
          // Use console-table-printer for arrays of objects
          const table = options?.tableColumns ? new Table({ columns: options.tableColumns }) : new Table();
          data.forEach(item => table.addRow(item));
          table.printTable();
        } else if (typeof data === 'object' && data !== null) {
          // For single objects or objects with nested arrays
          if (options?.tableColumns) {
            const table = new Table({ columns: options.tableColumns });

            // Extract the array data if it's nested (e.g., data.agents, data.functions)
            const arrayData = Object.values(data).find(val => Array.isArray(val));
            if (arrayData && Array.isArray(arrayData)) {
              if (arrayData.length === 0) {
                writeFn(`No ${Object.keys(data)[0]} found.`);
              } else {
                if (options.tableColumns) {
                  arrayData.forEach(item =>
                    table.addRow(
                      _.pick(
                        item,
                        options.tableColumns!.map(col => col.name)
                      )
                    )
                  );
                } else {
                  arrayData.forEach(item => table.addRow(item));
                }

                table.printTable();
              }
            } else {
              // Single object
              table.addRow(data);
              table.printTable();
            }
          } else {
            // Fallback: create a simple table without column configuration
            // For single objects, show properties as rows
            if (Object.keys(data).length > 0) {
              const table = new Table({
                columns: [
                  { name: 'property', title: 'Property', alignment: 'left' },
                  { name: 'value', title: 'Value', alignment: 'left' },
                ],
              });

              let hasRows = false;
              // Convert object properties to rows, but skip only non-empty nested objects and arrays
              Object.entries(data).forEach(([key, value]) => {
                if (value === null || typeof value !== 'object') {
                  // Include primitives and null
                  table.addRow({
                    property: key,
                    value: value,
                  });
                  hasRows = true;
                } else if (Array.isArray(value) && value.length === 0) {
                  // Include empty arrays
                  table.addRow({
                    property: key,
                    value: '[]',
                  });
                  hasRows = true;
                } else if (!Array.isArray(value) && Object.keys(value).length === 0) {
                  // Include empty objects
                  table.addRow({
                    property: key,
                    value: '{}',
                  });
                  hasRows = true;
                }
              });

              // Only print the main table if it has rows
              if (hasRows) {
                table.printTable();
              }
            }

            // Recursive function to handle nested structures
            const displayNestedData = (obj: any, prefix = '') => {
              for (const [key, value] of Object.entries(obj)) {
                const fullKey = prefix ? `${prefix}.${key}` : key;

                // Check for nested arrays, create one new table per array
                if (Array.isArray(value)) {
                  if (value.length > 0) {
                    writeFn(`\n${fullKey}:`);
                    const nestedTable = new Table();
                    value.forEach((item: any) => {
                      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                        nestedTable.addRow(item);
                      } else {
                        nestedTable.addRow({ value: item });
                      }
                    });
                    nestedTable.printTable();

                    // Recursively process objects within the array
                    value.forEach((item: any, index: number) => {
                      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                        displayNestedData(item, `${fullKey}[${index}]`);
                      }
                    });
                  }
                }
                // Check for nested objects, create one new table per object
                else if (
                  typeof value === 'object' &&
                  value !== null &&
                  !Array.isArray(value) &&
                  Object.keys(value).length > 0
                ) {
                  writeFn(`\n${fullKey}:`);
                  const nestedTable = new Table({
                    columns: [
                      { name: 'property', title: 'Property', alignment: 'left' },
                      { name: 'value', title: 'Value', alignment: 'left' },
                    ],
                  });

                  // Convert object properties to rows (only primitive values)
                  Object.entries(value).forEach(([propKey, propValue]) => {
                    if (propValue === null || typeof propValue !== 'object') {
                      nestedTable.addRow({
                        property: propKey,
                        value: propValue,
                      });
                    } else if (Array.isArray(propValue) && propValue.length === 0) {
                      nestedTable.addRow({
                        property: propKey,
                        value: '[]',
                      });
                    } else if (!Array.isArray(propValue) && Object.keys(propValue).length === 0) {
                      nestedTable.addRow({
                        property: propKey,
                        value: '{}',
                      });
                    }
                  });

                  nestedTable.printTable();

                  // Recursively process nested structures
                  displayNestedData(value, fullKey);
                }
              }
            };

            displayNestedData(data);
          }
        } else {
          // Fallback to text for non-tabular data
          writeFn(data);
        }
      } catch (error) {
        // Fallback to console.table if console-table-printer fails
        console.error('Table formatting error, falling back to console.table');
        if (Array.isArray(data) && data.length > 0) {
          console.table(data, options?.headers);
        } else if (typeof data === 'object' && data !== null) {
          console.table([data], options?.headers);
        } else {
          writeFn(data);
        }
      }
      break;
  }
}

function formatObject(obj: any, indent = ''): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${indent}${key}:`);
      lines.push(formatObject(value, indent + '  '));
    } else if (Array.isArray(value)) {
      lines.push(`${indent}${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${indent}${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

// Helper functions for common output patterns
export function outputSuccess(message: string, data?: any) {
  const { format } = globalOptions;
  if (format === 'json' || format === 'yaml') {
    output({ success: true, message, ...(data && { data }) });
  } else {
    output(`✅ ${message}`);
    if (data) {
      // Handle special data formatting for text mode
      if (data.functionId) {
        output(`Function ID: ${data.functionId}`);
      }
      if (data.functionName) {
        output(`Function Name: ${data.functionName}`);
      }
      if (data.nextSteps && Array.isArray(data.nextSteps)) {
        output('');
        output('Next steps:');
        data.nextSteps.forEach((step: string) => {
          output(`• ${step}`);
        });
      }
    }
  }
}

export function outputError(error: any) {
  const { format } = globalOptions;
  const errorMessage = error?.message || error;

  if (format === 'json' || format === 'yaml') {
    output({ success: false, error: errorMessage }, { error: true });
  } else {
    output(errorMessage, { error: true });
  }

  // Exit with error code in non-interactive mode
  if (!globalOptions.interactive) {
    process.exit(1);
  }
}

export function outputInfo(message: string) {
  const { interactive } = globalOptions;

  // Only show info messages in interactive mode (for progress, etc.)
  if (interactive) {
    output(message);
  }
}

// Helper for showing progress messages that should go to stderr in non-interactive mode
export function outputProgress(message: string) {
  const { interactive } = globalOptions;

  if (interactive) {
    console.log(message);
  } else {
    console.error(message);
  }
}
