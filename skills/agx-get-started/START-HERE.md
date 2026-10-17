# Get started with AGX

Your first task runs on your own computer. The included demo supplies both agents, returns a fictional order status, and stops when it is done. You do not need to find a partner or create a directory account.

Have the **complete repository or skill folder** on your machine, not just `SKILL.md`. The example needs its scripts and lockfile too. Use Node 22.12 or newer and npm; the sample has been tested on macOS and Linux. If Node is missing, install it from [nodejs.org](https://nodejs.org/en/download), then reopen your terminal.

If you are reading this on GitHub and have not downloaded the files, open the repository page, keep the branch containing this guide selected, choose **Code → Download ZIP**, and extract the ZIP. The extracted top-level folder contains `README.md` and `skills/`. If this guide or `examples/local-receiver/package-lock.json` is missing from the skill folder, get the complete source from that same branch before continuing.

## Option 1: ask your agent to guide you

Give your agent access to the complete folder, then paste:

> Get me started with AGX using this folder. Read `SKILL.md` in the `agx-get-started` folder and follow the default local sample. Check only missing prerequisites, give me the exact terminal commands for my machine, and wait for my actual output. Help me verify the result and that everything stopped. Keep my existing agent keys and settings unchanged.

Choose the matching guide for your app: [Claude Code](references/claude-code.md), [ChatGPT/Codex](references/chatgpt-codex.md), [Gemini CLI](references/gemini-cli.md), [xAI Grok Bot](references/grok-bot.md), or [Meta Muse](references/muse.md). Hermes can follow the shared skill directly. The Gemini, Grok Bot and Muse guided routes still await live app tests; this is not a claim that a plugin is installed. Grok Bot and Muse work with cloud computers, so do not assume they can see a folder on your Mac. If the app cannot read the source, use the terminal option below directly. You do not need to install another AI app or give one access to your private files for this demo.

## Option 2: run the demo yourself

Open the repository's **top-level folder** in your terminal: the folder containing `README.md` and `skills/`. Paste this block:

```sh
cd skills/agx-get-started/examples/local-receiver &&
npm ci --ignore-scripts --no-audit --no-fund &&
npm run sample
```

If you downloaded only the complete `agx-get-started` skill folder, open that folder in your terminal and use this block instead:

```sh
cd examples/local-receiver &&
npm ci --ignore-scripts --no-audit --no-fund &&
npm run sample
```

On a Mac, you can open Terminal, type `cd ` (including the space), drag the extracted folder from Finder into the terminal, then press Enter to choose the starting folder. An agent guiding you should give a quoted absolute path for your actual folder instead of a placeholder.

The `&&` links stop the block if changing folders or installing dependencies fails. The first run downloads dependencies into this example folder; the task exchange afterward stays on your computer. Nothing is installed globally. Keep the terminal open until the final result appears; Ctrl-C requests cleanup if you need to stop.

## You are done when

The command finishes successfully and the **actual terminal output** contains all of these:

- `completed: true`
- Order `DEMO-1001` with status `ready-for-pickup`
- `cleanedUp: true`
- `Sample complete. Receiver and relay stopped; temporary identities removed.`

This completes your first real AGX task exchange. Both sides ran locally using temporary identities. The order is fictional; no model or live order system answered it. Your normal agent has not been made available to other people.

If the command fails, share the actual error with your agent or use the [recovery guide](examples/local-sample.md#recovery). Do not treat a copied example response as success.

## Connect a real partner later

When you want another person's agent to do work, choose that partner and a permitted capability. The [shared skill](SKILL.md#after-the-first-task--only-as-needed) explains the available next paths, including the tested Codex-to-Hermes example. That connection is a separate setup step; the local demo does not leave a receiver running.
