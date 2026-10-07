# Contributing to Beeblio

Thanks for helping improve Beeblio. Please open an issue before starting a large change so the approach can be discussed.

## Local development

Follow the setup in [README.md](README.md). Use Node.js 24 and pnpm 11, then run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm build:eve
```

If you change the desktop app or the local server launcher (`scripts/local-servers.mjs`), also run `pnpm --dir desktop install` and `pnpm --dir desktop typecheck`, and check that both `pnpm dev` and `pnpm desktop` still start. If your change affects the installed app (its servers, paths, or packaging), build an installer as described in the README's "Build the installers" and check that it starts with a fresh profile, opens Settings on first run, and leaves no server processes after you quit. The [Desktop release](.github/workflows/desktop-release.yml) workflow can also be run by hand from the Actions tab to build all installers.

Do not commit `.env.local`, `.beeblio/`, linked project files, generated builds, or API credentials. Update the README and `.env.example` when changing setup or configuration. Explain behavior changes and how you checked them in pull requests.

## Contribution terms

Beeblio is source available under the [PolyForm Noncommercial License 1.0.0](LICENSE.md), and when you submit a pull request, your contribution is licensed under the same terms as the rest of the project. Beeblio also exists as a hosted service, which runs under a separate commercial license. Before we include a community contribution in the hosted service, we will ask for your OK on the pull request — a short reply confirming it is enough.

## Reporting problems

For bugs and feature requests, open a GitHub issue with steps to reproduce and the expected behavior. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of posting details publicly.
