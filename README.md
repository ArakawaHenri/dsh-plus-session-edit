# DSH Plus · Session Edit

English | [中文](README.zh.md)

Edit or retry historical messages in place, and continue interrupted sessions without starting a new branch.

Part of [DSH Plus](https://github.com/ArakawaHenri/dshplus) (`@dshplus/session-edit`).

## Install

Install `@dshplus/session-edit` in the DSH Plugin Manager (or install the [`@dshplus/bundle`](https://github.com/ArakawaHenri/dshplus) bundle):

```text
@dshplus/session-edit
```

## Usage

- **Edit & Regenerate**: Hover over any of your earlier messages and click the **Edit** icon. Update the text and hit **Regenerate**—everything after that message is trimmed and the model replies from there.
- **Retry**: Click the **Retry** icon under a message to re-run from that point with the same text and attachments.
- **Continue**: When a turn stops early (you clicked Stop, hit a network error, or reached `max_tokens`), leave the input box empty and the send button becomes a **Continue** button. Click it to let the model keep going without adding a dummy "continue" message.

Everything happens inside the current session, keeping your session ID, workspace, attachments, custom title, and model selection intact.

## License

MIT
