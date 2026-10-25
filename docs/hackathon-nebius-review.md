# Nebius x NVIDIA hackathon readiness

Reviewed October 25, 2026. **Hattera has a plausible fit, but the current demonstration is not yet a qualifying submission.** This review validates requirements and identifies work; it does not register, submit, publish, or establish eligibility.

## Verified event requirements

- **Deadline:** October 30, 2026, 10:00 a.m. PDT (**10:30 p.m. IST**). The submission period began August 26. Judging ends December 15. [Official schedule](https://nebiusglobalaihackathon.devpost.com/details/dates)
- **Required technology:** use Nebius Token Factory or Nebius AI Cloud and at least one NVIDIA open model. A local frontend and backend are permitted when the runtime inference uses Token Factory. NVIDIA inference through another provider alone does not qualify. [Event overview](https://nebiusglobalaihackathon.devpost.com/), [official FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs)
- **Submission:** a functioning demo, hosted application, or test build; a public source repository with license and setup instructions; an explanation of Nebius/NVIDIA use and service feedback; and a **public YouTube demonstration under three minutes** showing the working product and required technology. Materials must be in English or translated. [Submission requirements](https://nebiusglobalaihackathon.devpost.com/)
- **Existing work:** existing projects and forks are allowed if significantly updated during the submission period. Explain those changes, distinguish upstream work, and honor third-party licenses. Testing access must be free and available through judging; explain any necessary login. [Official rules](https://nebiusglobalaihackathon.devpost.com/rules)
- **Judging:** technology implementation, design, potential impact, and idea quality receive equal weight. A technically functioning build still needs a coherent product and a specific, credible use case. [Judging criteria](https://nebiusglobalaihackathon.devpost.com/)

## Current evidence and gaps

| Area | Assessment and next action |
| --- | --- |
| Nebius integration | The bundled [model catalog](../server/model-catalog/models-dev.snapshot.json) already contains Nebius Token Factory, `NEBIUS_API_KEY`, its endpoint, and NVIDIA models. **Actual configured runtime execution is unproven.** Do not add a duplicate provider or describe catalog entries as integration proof. |
| Required model execution | The current OpenCode/MiMo demonstration is product evidence, not evidence of Nebius plus NVIDIA use. Configure an authorized Nebius account, select a currently available NVIDIA model, and verify a meaningful tool/task workflow. Capture the selected model, successful execution, and usage without exposing credentials. |
| Hosting | A VPS is unnecessary for the permitted local architecture. Nebius documents an OpenAI-compatible endpoint at `https://api.tokenfactory.nebius.com/v1/`; existing generic transport is a plausible route, but actual model and tool compatibility must be tested. [Official quickstart](https://docs.tokenfactory.nebius.com/quickstart) |
| Product claims | Describe Docker bridge peer tests as Docker tests. Physical two-device Tailscale qualification and the project coding harness remain unfinished in current project documentation. A CLI-only startup flag does not establish a completed coding agent. |
| Submission access | An expiring pairing code or owner-only GitHub access is insufficient as the sole judge workflow. Provide a reproducible test build or durable testing instructions that remain usable throughout judging. Never publish provider credentials. |
| Published evidence | Update the tested public implementation, README, repository description, and dated contribution summary. The [public repository](https://github.com/Msalways/hattera) inspected during this review lagged local collaboration documentation. Add the required public YouTube URL; a README-local video alone is insufficient. |

## Licensing and eligibility checks

The root Apache license excludes `enterprise/`. [LICENSING.md](../LICENSING.md) and [enterprise/LICENSE](../enterprise/LICENSE) distinguish evaluation from production and restrict redistribution and third-party hosting. Review the exact submitted source and build scope: use an OSS-only distribution or establish the applicable permission. This is a licensing scope flag, **not a definitive legal opinion** or a conclusion that all Hattera branding requires an enterprise agreement. Preserve upstream attribution and third-party notices.

Entrant age, legal residence, team conflicts, and prior sponsor support are unknown. The rules exclude specified jurisdictions and related parties; the machine timezone does not establish eligibility. Verify the entrant's facts against the [official eligibility rules](https://nebiusglobalaihackathon.devpost.com/rules). City-award attendance guidance differs between the [FAQ](https://nebiusglobalaihackathon.devpost.com/details/faqs) and [resources](https://nebiusglobalaihackathon.devpost.com/resources); obtain clarification before relying on those awards.

## Recommended submission scope

**Assessment:** Personal AI or Apps and Agents currently fits the demonstrated memory, tools, and consented collaboration more closely than Coding and Agentic Engineering. Choose the coding track only after demonstrating code changes, execution, and testing. This is an assessment, not organizer confirmation.

Prioritize: verify a real Nebius/NVIDIA workflow; resolve distribution scope; publish reproducible judge access; then record an English demonstration under three minutes showing the problem, collaboration, actual required inference, and result. Explain the significant Hattera changes made since August 26. Registering, publishing to YouTube, and submitting remain separate user actions.
