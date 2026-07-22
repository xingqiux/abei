import { Command } from 'commander';

import { ConfigStore, redactToken } from '../core/config-store.js';

interface SetTokenOptions {
  profile?: string;
  url: string;
  token: string;
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage Firefly III authentication profiles.');

  auth
    .command('set-token')
    .description('Save a Firefly III URL and personal access token.')
    .option('--profile <name>', 'Profile name.', 'default')
    .requiredOption('--url <url>', 'Firefly III base URL.')
    .requiredOption('--token <token>', 'Firefly III personal access token.')
    .action(async function (options: SetTokenOptions) {
      const profile = this.optsWithGlobals().profile ?? options.profile ?? 'default';
      const store = new ConfigStore(this.optsWithGlobals().config);
      await store.setToken({
        profile,
        baseUrl: options.url,
        token: options.token,
      });
      const active = await store.getActiveProfile(profile);
      console.log(`Saved profile "${profile}" for ${active?.baseUrl ?? options.url}.`);
    });

  auth
    .command('use')
    .description('Set the active Firefly III profile.')
    .argument('<profile>', 'Profile name.')
    .action(async function (profile: string) {
      const store = new ConfigStore(this.optsWithGlobals().config);
      await store.useProfile(profile);
      console.log(`Active profile is now "${profile}".`);
    });

  auth
    .command('status')
    .description('Show the active profile without exposing the full token.')
    .action(async function () {
      const store = new ConfigStore(this.optsWithGlobals().config);
      const active = await store.getActiveProfile();
      if (!active) {
        console.log('No active profile configured.');
        return;
      }
      console.log(
        [
          `Active profile: ${active.name}`,
          `Base URL: ${active.baseUrl}`,
          `Token: ${redactToken(active.token)}`,
        ].join('\n'),
      );
    });
}
