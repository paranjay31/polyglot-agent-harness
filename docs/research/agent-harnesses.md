# Public architecture research notes

Research was limited to public documentation and papers; no source code was copied.

| Project | Useful public idea | Adopted here |
| --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md) | UI/control plane must not execute tools or own the sandbox. | Transport-neutral agent kernel and sandbox interface. |
| [OpenHands architecture](https://github.com/Ucode-io/openhands/blob/main/openhands/README.md) | Controller, state, and event stream are distinct concepts. | Bounded runtime plus typed append-only event sink. |
| [Goose architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md) | Tool calls are requested by models but executed by the harness; extensions are MCP tools. | One policy-gated registry for built-in and future MCP tools. |
| [SWE-agent paper](https://papers.nips.cc/paper_files/paper/2024/file/5a7c947568c1b1328ccc5230172e1e7c-Paper-Conference.pdf) | Configurable interfaces and context management make evaluation practical. | Model/tool interfaces and a scripted model for deterministic tests. |

Other surveyed projects (OpenCode, Cline, Kilo Code, Aider, mini-SWE-agent, Pi, DeepSeek Harness, and Plandex) reinforce the same separation of execution, context, state, and provider concerns. They are tracked as ongoing comparative research before implementing their specific later-phase features.
