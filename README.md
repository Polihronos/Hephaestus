# Hephaestus

A Windows desktop companion with a full dashboard, live screen preview, spoken conversation, app control, and a small animated sprite. It uses the existing signed-in subscription and local speech processing.

Open **Hephaestus** from the desktop or Start menu. Closing the dashboard leaves the sprite available. Double-click the sprite to reopen the app; right-click for its menu.

## Dashboard and overlay

The dashboard contains the live view, both sides of the conversation, voice settings, complete editable application prompt, and activity. **Thinking & tools** streams actual tool status and provider-supplied reasoning summaries. It does not fabricate private reasoning. The sidebar shows all-time recorded token usage, imported from app-owned historical sessions and persisted across restarts, including background refreshes and verification runs. Cached input is part of input, and reasoning is part of output; those subsets are not added twice.

**What I see** can show either the live local image or the last image sent to the conversation. Active-application capture stays readable behind the dashboard; entire-monitor capture is available too. Small text can be examined through a native-resolution zoom tool.

The supplied sprite pack provides idle, hammering and eight walking animations. Dragging Hephaestus moves the answer bubble with him. The bubble shows his answers, thinking dots and speaking animation. It contains no transcript or message entry. Clicking elsewhere dismisses it. Screenshot protection is disabled, so normal screenshots can include him.

Hephaestus can selectively point out useful things with temporary highlights and spontaneous observations. **Proactive** on the Companion page, or **Proactive observations** under What I see, controls that behavior. Manual drawing is not required. App controls operate on direct requests: click, type, scroll, change tabs, focus windows, and navigate the desktop. Stop interrupts a pending sequence; ambiguous consequential actions can request confirmation.

The conversation can take the full dashboard width with **Hide screen**. Streaming replies stay in the conversation; reading older messages preserves your position and offers **Latest** to catch up. Messages stay in the composer until their dispatch is acknowledged, and a failed send remains available for review and retry. Reconnection restores active work and missing replies from the runtime. **Stop** reports whether cancellation is confirmed; local desktop actions are revoked immediately even if the runtime cannot confirm the stop.

After confirmed Stop, the text already received stays in the conversation with an **Interrupted** label. It is saved immediately and remains available when you start another request.

Late replies are recovered into history without interrupting a newer reply.

If a request finishes without a text reply, it is marked **No text reply**. **Review message** returns the original text to the composer. Check Activity for any completed actions before sending it again.

If cancellation is not confirmed, **Retry Stop** retries the original request. After the reply has stopped, **Save Stop recovery** retries saving its recovery record for the next startup. Recovery-save retries do not cancel a newer request. A recovery-write error does not prevent Hephaestus from requesting cancellation while connected.

Settings that enable speech or app control take effect after a successful save. Failed changes stay inactive. Turning off screen sharing, control or microphone input takes effect immediately; if that change cannot be saved, the app explains that it remains active for this session and offers a retry. Save it successfully before restarting to keep that preference.

Messages over 16,000 characters are rejected visibly and remain intact for editing. Failed intentional dictation is saved as a recoverable request in the dashboard. Instruction changes wait for confirmed cancellation before replacing the active conversation. Quitting waits for an Instructions save already in progress before closing its runtime connection. Upgrades replace a previous default prompt only when its exact known fingerprint matches; custom instructions remain unchanged.

## Attention and screen privacy

**What I see** includes **Quiet for 15 minutes**, **an hour**, or **4 hours**. Direct replies continue while spontaneous observations are snoozed. Each unsolicited notice has **Helpful** and **Dismiss** controls; feedback survives restarts and helps suppress repeated subjects. Notices must include a current task, fresh visible evidence, a concrete next action, and its benefit. Duplicate suppression uses Unicode text similarity; it does not translate meanings or verify that a visual claim is correct.

**Keep these apps private** accepts executable process names from Windows Task Manager. Hephaestus checks them before and after capture, clears old previews when blocked, and withholds monitor or fallback screenshots while an excluded app is visible. You can continue a text-only conversation. These exclusions govern Hephaestus screen sharing; inherited workspace tools retain their own permissions. Model reasoning and selected screenshots use the signed-in service. Local speech processing does not make the complete conversation offline.

## Voice

**Wispr Flow is the default. Spoken replies start off.** Hephaestus does not open its microphone or start local transcription in Wispr mode. Press the usual Flow shortcut to dictate. A known editable input elsewhere keeps the text; Hephaestus is the fallback when no editor is identified. The optional always-listening mode remains available through voice settings but is not enabled automatically.

**Always listening** currently recognizes English. When explicitly enabled, it uses the microphone continuously with the required system-wide `echoCancellation: "all"` mode, noise suppression, voice activity detection, and local Whisper transcription. Computer playback stays audible. If the required mode is unavailable, the microphone fails closed with an actionable message. This separates playback from microphone speech; it does not identify a specific person among nearby speakers.

**Wispr Flow** keeps the existing dictation shortcut. The installed shortcut configuration is read without changing it. A focused external text field keeps dictation. Otherwise, Hephaestus focuses a small invisible input in his overlay, accepts Flow’s normal text insertion and sends it after it settles. Turn off automatic sending to review in the dashboard instead. While Flow is dictating, local transcription is suspended to avoid duplicate requests. Flow’s audio processing remains its own.

Neither mode mutes system output. No microphone audio is played back. Raw microphone segments stay local; recognized text and selected screen images go through the signed-in service. There is no new inference API key or separate inference subscription.

Pausing, changing the microphone or input mode, and starting a Wispr dictation discard audio from the previous listening session. Resuming does not replay queued voice commands. An input method can finish composing text with Enter without sending the unfinished draft.

| Shortcut | Action |
| --- | --- |
| Existing Wispr shortcut | Deliberate dictation |
| Ctrl+Alt+Space | Open dashboard and focus its message input |
| Ctrl+Alt+H | Open dashboard |
| Ctrl+Alt+Escape | Stop reply/control and dismiss popup |

## Configuration and limits

The complete application prompt is visible under **Instructions**. Saving replaces it in a fresh session and carries over recent conversation messages. There is no second application behavior prompt. Provider runtime and account instructions still apply separately.

Screen capture is local every 750 ms. A user request sends a current image, its dimensions, window title/process, pointer position, capture time and any attention point, together with the application prompt and conversation history. The conversation receives a fresh full-resolution application image; the watcher uses a smaller image to reduce usage.

When proactive mode is on, context refresh checks a changed screen at the configured interval (20 seconds by default). Turning proactive mode off leaves the live local preview running without background inference. The watcher uses a 1600-pixel image and a separate, temporary Luna session, so background screenshots no longer accumulate inside the main conversation. It can emit a useful notice, highlight or attention movement when proactive behavior is enabled, but cannot control apps. The model does not process every video frame. Both chat and background requests use the included allowance.

Movement has two triggers: dragging the sprite, or a model call to `move_attention`. That call can occur in a direct reply or a proactive screen check. There is no random wandering timer or requirement to move on every refresh.

Unambiguous commands such as "next tab," "scroll down," and "click here" execute locally without a model request. They verify the intended target and stop if focus changes; ambiguous browser targets require you to focus the right window. Other requests use the conversation model.

The default model is Luna 6 with low reasoning effort and standard service. The watcher always uses this economical configuration; conversation model and effort remain configurable. Replies render streamed text immediately; native action sequences combine up to six operations and typing uses batched Windows input. The application rejects API-key authentication and never purchases additional usage.

## Tools and T3 integration

Eight companion tools are exposed: `screen_observe`, `screen_zoom`, `screen_windows`, `screen_action` (including short sequences), `screen_annotate`, `move_attention`, `companion_notice`, and `t3_workspace`. Their descriptions are visible on the Activity page. The project-scoped MCP bridge exposes desktop control and direct T3 lookup independently of the separate computer-use UI connection. The conversation also inherits the signed-in runtime's shell, files, web and computer tools, configured MCPs, plugins, skills, and T3 tools. Authentication and runtime permissions follow the existing configuration.

`t3_workspace` discovers real project and conversation IDs, distinguishes identically named projects by folder, and registers a scratch conversation's existing folder as a project. T3 permits project reassignment only to that same folder. A running conversation can queue its move until idle; the operation is persisted in `t3-operations.json`, survives app restarts, and is verified against T3 before being marked complete. It does not move files. Paused, duplicate and cooling-down spontaneous notices return a normal suppressed result. During the 90-second notice cooldown the watcher skips inference, while the local screen preview continues.

Hephaestus is the desktop interface; T3 provides its conversation runtime. The app connects locally to T3's authenticated WebSocket stream for messages, tool activity, reasoning summaries, usage, cancellation, and reconnection. **Workspace** embeds the real T3 conversation UI, including its tool and request cards. **T3 usage** opens its original account-wide usage UI inside the dashboard. T3 must be running. The integration uses the installed local runtime contracts; it does not copy the application implementation.

The **Usage** view records timestamps, purposes, model, tools and request text, with date/model/purpose filters and daily charts. It separates input, cached input, output and reasoning; displays current API-equivalent USD value and estimated cache savings; and uses the same pricing catalog as T3. These figures are estimates of API value, not an additional subscription bill. Unknown models are marked unpriced. Historic totals without retained details remain unclassified instead of receiving invented dates or purposes.

Sleep or screen lock pauses the companion. Elevated windows can reject input. Recognition and model requests take processing time; the dashboard displays measured latency.

## Local build and installation

Prerequisites: Windows, Node.js 22 or newer, the **.NET 8 SDK**, `uv`, and the signed-in [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) with trusted `PreToolUse` hook support (tested with 0.167.0). Native and official npm Codex installations are supported. T3 must be installed and running. Wispr Flow is needed only for its dictation mode.

Before the first launch, enable T3's default **Codex** provider (`codex`) and sign in with your ChatGPT account. Luna 6 must be available in both Codex and the T3 provider's model catalog. Setup resolves the installed Codex launcher; it does not configure the T3 provider or grant model access.

Open T3 at least once to create its local command and runtime files. Hephaestus connects to the local runtime using orchestration protocol 2. Standard discovery uses `%USERPROFILE%\.t3`; custom installations can set `T3CODE_HOME` and `T3CODE_CLI_PATH` before starting Hephaestus.

```powershell
codex login status
npm run setup
npm run prepare-ui
npm test
npm start
```

Setup installs local transcription dependencies, verifies the public speech model and desktop runtime, and builds the native helper. `scripts/install-local.ps1` installs into `%LOCALAPPDATA%\ScreenCompanion` and creates **Hephaestus** shortcuts. The existing settings location remains `%APPDATA%\Screen Companion\settings.json` for compatibility.

Quit Hephaestus before running the installer for an update. Its preflight rejects a running installation before copying files. Interrupted runtime or speech-model downloads are verified and retried; incomplete files are never promoted into the installation.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

`node scripts/launch.cjs --hephaestus-check` verifies the dashboard, supplied sprite, real microphone echo mode, audible playback rejection, actual speech, popup attachment and dismissal, and a real model-controlled click in a temporary verification window. `--t3-check` verifies Luna through the real T3 runtime, inherited and desktop tools, native typing, proactive notices, Markdown, usage records, and the embedded workspace. Reports and actual screenshots go under `artifacts/`.

`node scripts/launch.cjs --route-check` checks native focus, armed dictation routing, duplicate protection and recovery of unsent text through the actual windows and input handlers. It uses a separate `runtime/route-verification` profile with sharing, background inference and microphone listening disabled. Text insertion and the model submission boundary are simulated and labelled in its report; this does not establish human speech accuracy or Wispr's own transcription quality. It exits after verification and returns a nonzero exit code on failure.

`node scripts/launch.cjs --quality-check-fast` checks the actual production windows at 960x620 and 1280x840, screen-pause behavior, navigation, and microphone defaults without model inference. `--quality-check` adds real local-command measurements, contextual replies, native typing through the conversation runtime, and snapshot reconciliation. These checks use a separate `runtime/quality-verification` data directory; they do not reset the normal application settings or conversation. The full check needs the signed-in allowance and briefly opens an input-verification window. Unit tests use isolated fixtures and do not require a signed-in account. The Windows build and automated tests also run in GitHub Actions.

`node scripts/launch.cjs --session-check` exercises actual UI sends, connection loss during a reply, missing-reply reconciliation, cancellation and a subsequent request in a separate `runtime/session-verification` profile. It also blocks an owned recovery-write path during real cancellation and checks the production recovery-save retry. It uses real model replies; filesystem, missing-cache-entry and action-free approval fault injections are labelled in the report. Screenshots, transcripts and token data are not fabricated. These short checks do not establish human speech accuracy or all-day proactive usefulness. Verification failures return a nonzero exit code.

## License

MIT. See [LICENSE](LICENSE). Vendored rendering libraries include their own licenses under `ui/vendor/`.

References: [subscription protocol](https://learn.chatgpt.com/docs/app-server), [echo cancellation modes](https://www.w3.org/TR/mediacapture-streams/#dom-echocancellationmodeenum), [Wispr dictation behavior](https://docs.wisprflow.ai/articles/6409258247-flow-bubble-requirements).
