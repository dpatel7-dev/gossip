# What's new in gossip

See this any time with `gossip changelog`, or in the chat: Tab, then "What's new".

## 0.6.0
- Calls: `/call maya` for voice, `/video maya` for video, also in the menu under "This chat". The call opens in your browser in gossip's own look, with mute, camera and screen sharing. Sound and video go straight between your computers, end-to-end encrypted.
- Answer with Enter (or `/answer`), turn it down with Esc (or `/decline`), end it with `/hangup`. Only people in your contacts can call you (`gossip config calls everyone` or `off` to change that).
- `/dashboard` opens a live page in your browser: every connection gossip makes, who is signed in as you (with a button to sign the others out), who can read each chat, security checks, your activity and calls.
- Update without leaving: `/update`, then `/restart` brings you straight back on the new version. Typing a command the shell way inside the chat (like `gossip update`) now just works.
- Pebble types along while you type and dances when you stop.

## 0.5.1
- Fixed Pebble not reacting to what you do. Pebble now also stays in the pose afterwards (typing, phone or dance) until something else happens.

## 0.5.0
- Change your username: `gossip rename newname`. Your chats, servers and contacts come with you, the people you talk to are switched over automatically, and nobody else can take your old name.
- `gossip mini`: a tiny chat for the corner of your screen while you work. Messages from every chat scroll by, and replies go to whoever wrote last. Tab picks someone else. Also in the menu as "Shrink to the corner".
- `gossip security`: checks the connection, anyone whose security key changed, and whether your account is open somewhere else.
- A warning the moment your account is opened in another place, and `gossip signout` to close the others.
- `gossip config security strict` refuses any connection that isn't encrypted.
- Messages through a gossip website arrive faster (it now checks about twice as often while you're chatting).
- The detailed Pebble now draws cleanly in macOS Terminal when the terminal reports its background colour; gossip falls back to the blocky one when it doesn't.

## 0.4.2
- A new blocky Pebble, drawn only with whole coloured squares, so no terminal can stripe it. macOS Terminal gets it automatically; choose yourself with `gossip config mascot.style blocky` or `smooth`.
- Fixed black notches around Pebble that 0.4.1 introduced in macOS Terminal.

## 0.4.1
- Fixed the thin stripes across Pebble in macOS Terminal: the penguin is now drawn so line spacing can't show through.

## 0.4.0
- Pebble is always around: every start opens with Pebble saying hello (any key skips it), and Pebble now lives at the bottom of the left column.
- Pebble reacts: picks up the phone when a message arrives, types when you type, dances when you send.
- Desktop pop-ups for new messages when you're away from the window (macOS and Linux). `gossip config notify preview` adds the message text, `off` stops them.
- A "new" line shows where the unread messages start when you open a chat.
- Emoji words: type `:fire:` or `:thumbsup:` and it's sent as the emoji (`gossip config emoji off` to stop).
- Actions: `/me waves` shows as "* dhruv waves".
- Fixed: the welcome penguin was hidden whenever you already had a chat open, and in short windows.
- Fixed: "Show older messages" in the full chat screen repeated messages you could already see.

## 0.3.0
- `gossip uninstall` (or `gossip delete`) removes gossip from your computer. It asks first, and lets you keep your account and messages.
- Update notes: `gossip changelog` shows what changed in each version and when this computer updated.
- Your People list now only holds people you added. Someone who messages you shows under "Others" until you've read it; nobody is put on your list for you.
- A server's owner can remove anyone, online or not, including people who were invited but haven't joined yet (Tab, Servers, Remove someone, "Someone not listed").
- Hand a server to another member: `gossip give maya gamedev`.
- Mute a chat: `gossip mute maya` (same command to unmute).
- Search your saved messages: `gossip find pizza`.
- Save a chat to a text file: `gossip export maya`.
- Installing: the `gossip` command now works in the same window when it can, and the installer says exactly what to do when it can't.
- The penguin no longer shows thin gaps between its lines in macOS Terminal.

## 0.2.1
- The gossip website at djp7.pythonanywhere.com is the default place to chat.

## 0.2.0
- A full chat screen: chats on the left, the conversation on the right, arrow keys, mouse and a Tab menu.
- The same menu in the classic scrolling look.
- The install website can pass messages along, so friends don't need a relay address.
- `gossip nearby`: chat with people on the same Wi-Fi or cable, with no internet.
- gossip updates itself.

## 0.1.0
- First version: end-to-end encrypted direct messages and servers, contacts, themes, Pebble the penguin.
