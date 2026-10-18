# Publishing the source on GitHub

The source is prepared as Motion2D 0.2.0, an experimental prototype under MIT.
Repository metadata targets `adonisglobal/motion2d-web`. Preparing this checkout
does not create or publish a remote repository.

## Before the first push

Run the documented setup and validation:

```sh
npm ci
npm run setup:assets
npm test
npm run build
git status --short
git ls-files
```

Review the tracked file list. It must contain no personal media, `.local/`,
`node_modules/`, `dist/`, `.env` files, downloaded WASM files, or model binaries.
Review the README, MIT license, and third-party notices. The built application
includes dependencies and a downloaded model governed by separate terms;
the first public package should be the source repository.

## Create the public repository

With GitHub CLI authenticated to the intended account, from this project's
initialized and committed Git repository:

```sh
gh auth status
gh repo create adonisglobal/motion2d-web --public --source=. --remote=origin --push --description "Experimental browser motion capture and PNG character animation studio"
```

Use a different owner/name only after updating the metadata in `package.json`
and this guide. If the remote already exists, inspect it first; do not overwrite
another repository or force-push its history.

## Verify publication

- Confirm the repository is public, its default branch is `main`, and GitHub
  recognizes the MIT license.
- Wait for the CI workflow to finish. It installs locked dependencies, runs the
  tests, verifies the model setup, and creates a production build on Linux.
- Enable private vulnerability reporting in the repository's security settings
  if a maintainer can monitor it. Follow `SECURITY.md` for reporting guidance.
- Confirm source archives contain only intended files. Model/runtime downloads
  and developer test media must remain excluded.
- Describe the release as an experimental prototype. OpenToonz export is planned;
  canonical JSON is not an OpenToonz project or an importable animation package.

This workflow does not publish a website, npm package, or binary release.
Those distributions need their own validation and dependency/model notice review.
