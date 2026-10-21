# Validation history and remaining checks

Read this when assessing evidence or planning a live validation. For instructions, use the [human Start Here guide](../START-HERE.md) or the [Hermes walkthrough](../examples/claude-hermes/SETUP.md).

## Versions and release guidance

The local communication sample and Hermes kit deliberately retain published CLI **0.3.0** in their package manifests and lockfiles. Their historical live results are evidence for that baseline, not for a newer CLI. The optional Claude/Codex global-install instructions and n8n walkthrough instead use published **0.4.0**. Compatible existing global installations can be reused; they do not replace the examples' local dependencies.

An npm registry check on October 21, 2026 found CLI releases through 0.4.0 and n8n package 0.4.0. CLI versions 0.3.1 and 0.3.2 were not published; their appearance in earlier source snapshots did not make them installable releases. Package versions on the repository's default branch are not proof of npm publication.

## Historical real AI exchanges

| Path | Runtime used | Observed result | Limits |
| --- | --- | --- | --- |
| Claude Code → Hermes, revision 2 | Claude Code 2.1.285; macOS; Node 24.13.0; CLI 0.3.0; Hermes v0.21.5 on Linux VPS | Direct requester send, clean model summary and operator-confirmed automatic test-group cleanup | That run's fresh READY did not explicitly reconfirm every private-context condition. It did not test the later revision-4 runtime or an installed AGX marketplace plugin. |
| Standalone Codex desktop → Hermes, revision 4, October 17, 2026 (Chicago) | macOS; Node 24.13.0; CLI 0.3.0; Hermes v0.21.5+4911.g6ec0520.dirty on Linux VPS | One directly observed digest-bound request returned a verified clean summary and matching fresh nonce. Operator supplied complete fresh READY and matching status/process-group shutdown confirmation. | Remote readiness/shutdown were operator reports, not an independent SSH audit. No installed AGX marketplace integration or ordinary ChatGPT requester was tested. |

Between those runs, review added digest binding, public-key checksum checks, receiver overlap protection, bounded client/process-group supervision and output-failure cleanup. A Codex readiness check correctly stopped when inherited gateway settings could override the temporary workspace. Revision 4 removed the child gateway marker and pinned the effective workspace; the later successful Codex run included an operator no-model startup/configuration probe confirming that directory.

## Subsequent environment hardening

The October 21 review identified that the Hermes child still inherited `AGX_HOME`, pointing to the isolated receiver's key folder. The handler now removes **all `AGX_*` variables** from the child while preserving non-AGX provider authentication and its temporary workspace pins. The actual-child regression checks that synthetic AGX settings are absent, a synthetic provider credential and PATH survive, the parent environment is unchanged, and the temporary directory is removed.

This regression and simulated-model loopback exchanges do not establish a new real-model Hermes run. The zero-tool selection remains version-dependent and must be verified after plugin discovery for each fresh receiver, together with every private-context check in the walkthrough. Environment filtering is not an OS sandbox.

## n8n evidence

The inactive workflow originated from [PR #7](https://github.com/ellavox-ai/nostr-agx/pull/7), head `762930710957b9138232cb7d2e6757e50c588350`. Its node type, parameters and credential display name have since been checked against the published **0.4.0** package. The fictional lookup code was exercised with simulated n8n input. PR #7 reported node tests on n8n 2.43.7; those tests do not establish that this particular workflow imported or exchanged a task in real n8n.

## Checks still requiring live environments

- Fresh-session Hermes onboarding from complete source without the previous kit/dependencies.
- A new Claude Code run with the complete fresh READY checks and current kit.
- A real Hermes run after the child-environment filtering change.
- Gemini CLI, xAI Grok Bot and Meta Muse guided onboarding; native discovery/registration is a separate result.
- Installed Claude/Codex marketplace integration and host-specific installation/send controls.
- Ordinary ChatGPT requesting and real n8n workflow installation/import/exchange.

Keep these limits visible when describing support. Local tests, a published package, or a historical successful exchange do not substitute for the missing live checks.
