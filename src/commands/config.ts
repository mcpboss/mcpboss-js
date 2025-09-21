import { Command } from 'commander';
import {
  getDefaultOrganization,
  getOrganization,
  listOrganizations,
  OrganizationConfig,
  readConfig,
  removeOrganization,
  setDefaultOrganization,
  setOrganizationConfig,
} from '../config.js';
import * as openidClient from 'openid-client';
import open from 'open';
import { output } from '../output.js';
import { ConfigLoader, McpBoss } from '../../lib/index.js';

export function createConfigCommand(configLoader: ConfigLoader): Command {
  const configCommand = new Command('config').description('Show configuration requirements and current status');

  configCommand.addCommand(
    new Command('show').description('Show current configuration').action(() => {
      const config = configLoader.getConfig();
      output({ config: JSON.parse(JSON.stringify(config)) });
    })
  );

  configCommand.addCommand(
    new Command('token').description('Prints the token which would be used for any request').action(async () => {
      const config = configLoader.getConfig();
      output({ token: await config.token() });
    })
  );

  configCommand.addCommand(
    new Command('login')
      .description(`Login using OIDC authentication flow. Example: mcpboss login my-organization`)
      .argument('<org-id>', 'Organization ID (e.g., org123)')
      .option(
        '-b, --base-url <base-url>',
        'Base URL (default: none) - experimental - hardcodes the base URL for development purposes only'
      )
      .action(async (orgId: string, options: { baseUrl?: string }) => {
        try {
          const baseUrl = options.baseUrl || `https://${orgId}.mcp-boss.com`;
          const config = await openidClient.discovery(new URL(baseUrl), `${orgId}-cli`);

          const scope = 'openid profile email offline_access mcpboss.selfservice';
          const response = await openidClient.initiateDeviceAuthorization(config, { scope });

          console.log(
            `Please open ${response.verification_uri_complete || response.verification_uri} to complete the login. If required enter ${response.user_code}`
          );
          open(response.verification_uri_complete || response.verification_uri);

          const result = await openidClient.pollDeviceAuthorizationGrant(config, response);

          setOrganizationConfig(orgId, {
            baseUrl,
            tokens: {
              access_token: result.access_token,
              refresh_token: result.refresh_token!,
              expires_at: result.expires_in ? Date.now() / 1000 + result.expires_in : 0,
            },
          });

          console.log(result);
          console.log('Login successful! Refresh token saved. You can now use the CLI commands.');
          const allorganizations = listOrganizations();
          if (allorganizations.length === 1) {
            setDefaultOrganization(baseUrl);
            console.log(`Set ${baseUrl} as the default organization since it's the only one configured.`);
          } else {
            console.log(`Current default organization: ${getDefaultOrganization()}`);
            console.log(
              `Do you want to set ${baseUrl} as the default organization? Use "mcpboss config org set-default ${baseUrl}" to do so.`
            );
          }
        } catch (error) {
          let didPrintCause = false;
          if (error instanceof openidClient.ClientError && error.cause) {
            const cause = error.cause as any;
            if ('body' in cause && cause.body instanceof ReadableStream) {
              try {
                const reader = cause.body.getReader();
                const chunks: Uint8Array[] = [];
                let done = false;

                while (!done) {
                  const { value, done: readerDone } = await reader.read();
                  done = readerDone;
                  if (value) {
                    chunks.push(value);
                  }
                }

                const bodyText = new TextDecoder().decode(
                  new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], [] as number[]))
                );
                console.error('Failed with message:', bodyText);
              } catch (streamError) {
                console.error('Failed to read error body stream:', streamError);
                console.error('Caused by:', cause.body);
              } finally {
                didPrintCause = true;
              }
            }
          }
          if (!didPrintCause) {
            console.error('Error during login:', error);
          }
          process.exit(1);
        }
      })
  );

  configCommand.addCommand(
    new Command('set-api-key')
      .description('Set API key for an organization')
      .requiredOption('-t, --key <key>', 'API key')
      .requiredOption('-o, --org-id <org-id>', 'Organization ID (legacy, will be converted to baseUrl)')
      .option('--default', 'Set this organization as the default')
      .action(async ({ apiKey, orgId, default: isDefault }: { apiKey: string; orgId: string; default?: boolean }) => {
        try {
          const baseUrl = `https://${orgId}.mcp-boss.com`;

          setOrganizationConfig(orgId, {
            baseUrl,
            apiKey,
          });

          // Set as default if requested or if it's the first organization
          if (isDefault || listOrganizations().length === 1) {
            setDefaultOrganization(orgId);
            console.log(`${orgId} is now the default organization.`);
          }

          console.log('Authentication credentials saved successfully!');
        } catch (error) {
          console.error('❌ Error saving credentials:', (error as Error).message);
          process.exit(1);
        }
      })
  );

  configCommand
    .addCommand(
      new Command('ls').description('List all configured organizations').action(() => {
        const orgs = listOrganizations();
        const defaultOrgId = getDefaultOrganization();

        if (orgs.length === 0) {
          console.log('No orgs configured.');
          return;
        }

        console.log('Configured orgs:');
        orgs.forEach(organization => {
          const config = getOrganization(organization);
          const isDefault = organization === defaultOrgId;
          console.log(`  ${isDefault ? '* ' : '  '}${organization}`);
          if (config?.baseUrl) console.log(`    Base URL: ${config.baseUrl}`);
          if (config?.apiKey) console.log(`    API Key: [SAVED]`);
          if (config?.tokens?.access_token) console.log(`    Access Token: [SAVED]`);
          if (config?.tokens?.expires_at)
            console.log(`    Access Token Expiry: ${new Date(config.tokens.expires_at * 1000).toISOString()}`);
          if (config?.tokens?.refresh_token) console.log(`    Refresh Token: [SAVED]`);
        });

        if (defaultOrgId) {
          console.log(`\nDefault organization: ${defaultOrgId}`);
        }
      })
    )
    .addCommand(
      new Command('set-default')
        .description('Set default organization')
        .argument('<org-id>', 'ID of the organization to set as default')
        .action((orgId: string) => {
          try {
            setDefaultOrganization(orgId);
            console.log(`✅ Set ${orgId} as default organization`);
          } catch (error) {
            console.error('❌ Error setting default organization:', (error as Error).message);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command('remove')
        .description('Remove a organization configuration')
        .argument('<org-id>', 'ID of the organization to remove')
        .action((orgId: string) => {
          try {
            removeOrganization(orgId);
            console.log(`✅ Removed organization ${orgId}`);
          } catch (error) {
            console.error('❌ Error removing organization:', (error as Error).message);
            process.exit(1);
          }
        })
    );

  return configCommand;
}
