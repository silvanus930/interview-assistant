# Ethos Transcript Extractor / Ethos Copilot (Chrome extension) v1.9.0

Docks a panel beside the Ethos call window on `agent.askethos.com`, reads the live transcript, and gets a short spoken-style answer for what Ethos just asked from the Interview Assistant app running on this computer. The answer shows in the panel and is sent to Telegram.

## Install / update
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. **Updating:** copy the files of this folder over the folder you loaded before, then click the extension's reload ↻ button. This keeps your saved settings. (Loading it from a new folder with **Load unpacked** also works, but starts with empty settings.)
3. **First install:** click **Load unpacked** and select the `ethos-transcript-extractor` folder.
4. Keep only one copy of this extension enabled. Remove or disable any older copy, or you get two panels.
5. The transcript opens automatically during a call. You do not need to reload the call page: the panel attaches to Ethos pages that are already open. If it does not appear, click the extension's toolbar icon and press **Show panel** / **Start on this page**.

## The panel
- **One modal.** When a call window opens, the panel joins onto its right edge: same top and height, no gap, the touching corners squared off, one shadow around both. The joined modal is centered on the screen, which slides the call window sideways. The panel is 380 to 720 px wide depending on the browser window, with larger text when it is wide. Floating or minimizing the panel puts the call window back exactly as the page had it. If the browser window is too narrow for both, the panel sits along the right edge instead.
- **Answer first.** Once an answer exists, the top card shows it in full at reading size, with the question in small text above it.
- **Scrolls on its own.** The Ethos page blocks scrolling outside its call window during a call; the panel handles the mouse wheel itself, so its lists still scroll.
- **Transcript opens by itself.** The extension clicks **View transcript** for you. If you hide it yourself, it stays hidden for the rest of that call.
- **"Ethos just asked" card** at the top of the Questions tab shows the question Ethos asked (the call window beside it already shows the full transcript) and the generated answer under it. Click the question to see everything Ethos said since your last answer. While Ethos is still talking, the card says "Ethos is speaking".
- **Transcript tab** shows a chat with Ethos on the left and you on the right. Hover over an Ethos message to copy or send it.
- **When the call ends,** the panel shrinks to a small **Ethos Copilot** pill in the bottom-right corner. Click it to reopen. The next call starts a new saved session automatically.
- **Header buttons:** dock/float, settings, and minimize to pill. Drag the header to float the panel anywhere.
- **Settings → On the Ethos page:** turn auto-open, joining, and centering on or off. With centering off, the call window stays where the page puts it and the panel joins onto it there.

## Sign in (toolbar icon)
The extension is your client for the Interview Assistant. It signs in with the same email and password as the dashboard.

1. Make sure the Interview Assistant server is running and you have an account on it (an administrator creates accounts).
2. Click the extension's icon in the browser toolbar. Enter the **server address** (for a server on this computer: `http://127.0.0.1:8765`), your **email** and your **password**, and press **Sign in**.
3. On the call page, open the panel's settings, pick the **Profile** whose résumé and Telegram chat should be used, and **Save**.

Sign-in is in the toolbar popup, not in the panel, so your password is never typed into the call page. The extension stores a personal key, not your password. To switch account, use **Sign out** in the popup. If your account is disabled, or you press **Sign out the extension everywhere** in the dashboard, the extension is signed out and asks you to sign in again.

If the popup says your account cannot generate answers, the server is running on its owner's Claude subscription, which only administrators may use; ask your administrator to switch the server to an API key.

## Answers
- **Auto-answer when Ethos finishes speaking** (on by default): about a second after Ethos stops adding text, everything it said since the last request is sent to the app as one message, lead-in and question together. The answer streams into the "Ethos just asked" card; **Copy answer** copies it.
- A second question a few seconds later in the same turn is sent on its own. Its answer takes over the top card, and the earlier one moves into the list below.
- Statements with nothing to answer ("Thanks for your time") are not sent. Press **Answer** on the top card to answer one anyway.
- **Regenerate** on the top card asks again for the same message. **Answer** / **Again** on a question card in the list answers that card on demand.
- When one message holds two questions, the answer covers both; the earlier card says it was answered together with the next question.
- **Send answers to Telegram**: the app sends each answer to the profile's Telegram chat, using the workflow's message template.
- **Send the conversation so far as context**: the last 14 transcript messages go along with each request, so follow-ups like "Can you expand on that?" are answered in context. The app also remembers the answers it already gave in this call and avoids repeating them.
- What is already on screen when the panel starts in the middle of a call is listed but not auto-answered. A call that starts while the panel is running is answered from its first question.

Your résumés, prompts, answer length, model and the Telegram message format live in your account on the dashboard (Profiles, Workflows, Account), not in the extension.

## Questions tab
- Below the top card, every sentence ending in "?" shows up as a card, newest first. New ones are outlined.
- The copy button copies just that question. **Telegram** sends the question itself. Click a question to see the full message it came from.
- **Copy all questions** copies them as a numbered list.
- By default only Ethos's questions are collected. Your own (right-aligned) messages are ignored.

## Telegram directly from the extension (optional)
This sends the *questions* straight from the browser, without the app. With the app connected you usually do not need it, because the app's Telegram message already contains the question and the answer.
1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token into **Bot token**.
2. Send any message to your new bot, then click **Find** to fill in your chat ID.
3. Click **Test Telegram**, then **Save**.
4. Optional: **Auto-send new questions** pushes every new question to Telegram as soon as it appears.

Do not use **Find** with the same bot the Interview Assistant is listening on: only one program can read a bot's incoming messages at a time. Send `/start` to that bot instead; the app replies with the chat ID.

## Other
- **Pick**: if auto-detect fails, click it and then click the transcript on the page.
- The Transcript tab exports with **Copy all**, **.txt** or **.json**.
- **Alt+Shift+T** shows or hides the panel.
- The toolbar popup lists your last 50 saved sessions.
- Data stays in your browser (`chrome.storage.local`). Ethos's messages and the recent conversation go only to the Interview Assistant on this computer (`127.0.0.1`); Telegram messages go to `api.telegram.org`.
