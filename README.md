# Ariadne

Ariadne turns a codebase into a 3D map you can explore: its services, how they talk to each other, the requests that flow through them, and the code behind every step.

![Ariadne demo](docs/demo.webp)

<sub>The [OpenTelemetry Demo](https://github.com/open-telemetry/opentelemetry-demo), mapped in about a minute. [HD video](docs/demo.mp4)</sub>

## Install

You need Python 3.10+, git, and one coding agent CLI: [Claude Code](https://docs.claude.com/en/docs/claude-code), [pi](https://github.com/earendil-works/pi), [opencode](https://opencode.ai) or [codex](https://github.com/openai/codex). For the function-level view, also install [uv](https://docs.astral.sh/uv/).

```sh
git clone https://github.com/blackhat-7/ariadne
cd ariadne
```

No other dependencies.

## Use

```sh
python3 ariadne.py build ~/code/my-repo -o my-repo.map.json
python3 ariadne.py serve my-repo.map.json --repo ~/code/my-repo
```

Open http://127.0.0.1:7777.

`build` shows a usage estimate and asks which agent and model to use. To skip the questions: `--agent claude --model sonnet --yes`.

## In the app

- Zoom in to go from domains to services to functions to code.
- Press ▶ on a flow to play a request step by step.
- Click a function to see its callers and callees.
- Ask the chat a question; it answers from the code and moves the view.
- ⚙ Settings: chat model, voice narration, and the Glass or Voxel look.

Pinch or scroll to zoom, drag to rotate, `/` to search, `Esc` to go back.

## Notes

- Everything runs locally. Your agent CLI sends the code it reads to its provider.
- Map files contain snippets of your code. Keep them private.
- `serve --host 0.0.0.0` makes the map and your code reachable from your network.
- Every `file:line` in a map is checked; anything that doesn't match is marked ⚠.

## License

MIT
