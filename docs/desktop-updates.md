# Desktop releases and updates

How a new version of the desktop app gets from a tag to people's computers.

## Flow

1. **Version.** Set `version` in `desktop/package.json`, for example `0.2.0`, and merge it into `main`.
2. **Tag.** Push a tag matching it: `git tag v0.2.0 && git push origin v0.2.0`. The [Desktop release](../.github/workflows/desktop-release.yml) workflow checks that the tag and the version agree.
3. **Build.** The workflow builds on a macOS and a Windows runner, then creates a **draft** GitHub Release with:
   - the installers: `Beeblio-<version>-mac-arm64.dmg` and `Beeblio-<version>-win-x64.exe`;
   - the update files: `latest-mac.yml` and `latest.yml`, which name the newest version and its checksums; `Beeblio-<version>-mac-arm64.zip`, which macOS installs updates from; and the `*.blockmap` files, which let Windows download only the parts that changed.
4. **Review.** Install the draft's installers on both platforms. Nobody else sees the draft yet.
5. **Publish.** Publishing the draft hands the version to every installed app. Edit the generated notes first; the update prompt links to them.

## Channels

| Tag | Release | Who gets it |
|---|---|---|
| `v0.2.0` | Release | Everyone, at their next check |
| `v0.2.0-beta.1` | Prerelease | Nobody automatically. Testers download it from the release page |

The installed app ignores drafts and prereleases. Version numbers must only go up: an update is offered only when the published version is newer than the running one.

## In the app

The app checks 15 seconds after it starts, then every 6 hours, and on **Check for Updates…**: in the **Beeblio** menu on macOS, and the **Help** menu on Windows. Background checks that fail, for example offline, are only written to `servers.log`. A manual check always says what happened.

| Platform | What happens |
|---|---|
| Windows | The update downloads in the background. Beeblio then offers **Restart now**, which stops its servers and runs the installer, or **Later**, which installs it the next time you quit. |
| macOS, signed | The same as Windows. |
| macOS, not signed (today) | Beeblio says a new version is available, and **Download** opens its release page. macOS refuses to install updates into an app without a Developer ID signature, so this is the most it can do. |
| Run from a checkout, Linux | No update checks. |

The build decides the macOS behavior: once the `MAC_CERTIFICATE` secret exists (see the README's *Signing*), Mac builds install updates themselves, with no code change. Each version is offered once per run; **Later** is not asked again until the next start.

Projects, settings, and the database are in the user's data folder, not the app's folder, so an update keeps them. The database migrates forward when the new version starts. Going back to an older version is not supported once a newer one has migrated the database.

## Where updates come from

The app reads the GitHub Releases of one repository, fixed when it is built:

- the repository variable `BEEBLIO_RELEASE_REPO` (`owner/repo`), if set under **Settings → Secrets and variables → Actions → Variables**;
- otherwise the repository the workflow runs in.

The app reads releases without signing in, so **updates only work from a public repository**. While releases live in a private repository, checks fail quietly and nobody is told about updates. Once releases are published from a public repository, such as upstream `alharkan7/beeblio-oss`, builds made from then on update from there. Installs made before then keep looking where they were built to look, so they need one manual install of a build that points at the public repository.

## When a release is bad

- **Before anyone updated:** delete the release, or turn it back into a draft, and its tag. Apps keep offering the previous version.
- **After people updated:** publish a fixed, higher version, such as `0.2.1`. Apps never move to a lower version by themselves.

## Testing an update

The full path needs two published releases in a public repository:

1. Publish `vX.Y.Z` and install it.
2. Release and publish `vX.Y.Z+1`.
3. Start the installed app, or choose **Check for Updates…**, and follow the prompt.
