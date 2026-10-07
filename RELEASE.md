# Owner release: AgentKit provider

This bundle proposes the public GitHub repository
`voidly-ai/pay-marketplace-agentkit` for
`@voidly/pay-marketplace-agentkit`. The package starts at version `0.1.0`.
The bundle contains source and release automation; it is not a published
package or an enabled wallet integration.

1. Create the exact public repository and place these files at its root.
   Keep `package.json` and `package-lock.json` at the same version.
2. In npm package settings, configure a **trusted publisher** for the exact
   package, GitHub owner `voidly-ai`, repository
   `pay-marketplace-agentkit`, workflow `publish.yml`, and environment
   `npm-publish`. Permit direct `npm publish` in the current npm trusted
   publisher settings (a stage-only trust configuration will not work).
   Configure that GitHub environment and protect release tags.
   The workflow uses OIDC and contains no npm token. If npm requires a first
   owner-managed publication before trusted publishing can be configured,
   complete that bootstrap separately and verify it before pushing a release
   tag. If the bootstrap publishes `0.1.0`, bump both package and lockfile to
   the next unused version before tagging: this workflow rejects an npm version
   that already exists. It also intentionally fails without trusted publisher
   setup.
3. Let `check.yml` pass on `main`. For each release, update the package and
   lockfile versions together, review the packed contents, then push a tag
   exactly `v<package version>` at the reviewed commit.
4. Confirm that `publish.yml` succeeded, then read back the exact version,
   tarball integrity and provenance from npm. A green source check alone
   does not establish publication.

The default actions are public reads. Wallet buy/sell actions require a
trusted host, wallet-kit 0.2.0, a one-use permit, fixed network and caps, and
recovery of the original payment attempt when delivery is incomplete. Do not
enable a live wallet from this release workflow.
