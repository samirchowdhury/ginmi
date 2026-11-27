# ginmi

ginmi (吟味, "careful scrutiny before accepting something") is a browser UI for reading code reviews and asking clarifying questions about them.
You select a sentence or a diagram node, ask a question, and get an immediate answer in a thread anchored to that spot.

## Install

```sh
cd ~/ginmi && npm install && npm link
```

Requires macOS (threads run under `sandbox-exec`), Node 20+, and [pi](https://pi.dev) on `PATH`.

## Use

A review workspace is a directory containing `review.json` (see [DESIGN.md](DESIGN.md#manifest)); the `eng-governance-review` skill writes one.

```sh
ginmi open <workspace>    # prepare the clone and context pack, start the server, print the URL
ginmi feedback <workspace>  # print your decisions and threads as a handoff for an agent
ginmi stop                # stop the background server
```

Use **Save as TODO** in a thread to leave a task for that agent without asking the model; TODOs are listed first in the handoff.
To have an agent act on your feedback, click **Copy feedback handoff** in the page and paste the line into any agent session started in a checkout of the MR branch (or add "in a new worktree").

The server listens on `127.0.0.1:7477` (`GINMI_PORT` to change) and logs to `~/.local/share/ginmi/server.log`.
Set `GINMI_MODEL` to choose the pi model for answers; otherwise pi's default is used.
Opening a workspace for the first time makes one warm-up request to pi, which also warms the prompt cache.
Telemetry is local: `<workspace>/ginmi/events.jsonl`, copied to `~/.local/share/ginmi/events/`.

See [DESIGN.md](DESIGN.md) for the design.
