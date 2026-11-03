# Donut Assistant: AI chatbot demo

A small chatbot that finds the nearest store, gives phone numbers and hours, answers menu questions and builds a (demo) order. It costs $0 to run: Google's Gemini API free tier plus Netlify's free hosting.

## How it works

```
Browser (public/index.html)
   │  sends the chat + the user's location (if shared)
   ▼
Backend function (netlify/functions/chat.mjs)   ← your API key lives ONLY here
   │  adds the instructions (system prompt) + list of tools
   ▼
Gemini AI ──"I need find_nearest_stores"──► backend runs normal code on data/stores.json
   ◄──────────── results ────────────────────┘
   │  writes the friendly reply
   ▼
Browser shows reply (+ order summary if there is one)
```

The AI handles the conversation. Your code and your data files handle the facts (distances, prices, phone numbers), so it can't make them up.

| File | What it is |
|---|---|
| `public/index.html` | The chat screen |
| `netlify/functions/chat.mjs` | The backend: system prompt, tools, calls Gemini |
| `data/stores.json` | Store list: **fill in real details** |
| `data/menu.json` | Menu and prices: **replace the example items** |

## Setup (about 30 minutes)

1. **Install Node.js** (LTS) from nodejs.org if you don't have it. Check with `node --version`.
2. **Install the Netlify CLI:** `npm install -g netlify-cli`
3. **Get a free Gemini API key:** go to aistudio.google.com, sign in with a Google account, click **Get API key → Create API key**. No credit card needed.
4. **Add your key:** in this folder, copy `.env.example` to a new file called `.env` and paste the key in. `.env` is in `.gitignore`, so it won't end up on GitHub.
5. **Fill in the data:** edit `data/stores.json` (real addresses, phones, hours, and lat/lng from Google Maps: right-click a spot → click the coordinates to copy them) and `data/menu.json`.
6. **Run it locally:** `netlify dev`, then open the localhost link it prints. Try "where's my nearest store?" and "2 glazed and a Boston cream from Chatswood".

## Put it online (free)

1. Push this folder to a GitHub repo.
2. At app.netlify.com: **Add new site → Import from GitHub** → pick the repo. Build settings come from `netlify.toml`.
3. In the site's **Environment variables**, add `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`). Redeploy.
4. You get a `something.netlify.app` link to show people on their phones.

## Things to know

- **Model name:** defaults to `gemini-3.1-flash-lite`. Google renames and retires models often. If you get a "model not found" error, check the model list in AI Studio and set `GEMINI_MODEL`.
- **Free tier limits:** a capped number of requests per minute and day. Plenty for a demo; you'll see a friendly "try again in a minute" if you hit it.
- **Privacy:** on Google's free tier, chats can be used to improve their models. Fine for a demo with made-up orders; for real customers you'd switch to a paid tier.
- **Ordering is fake:** `update_order` only builds a cart. Sending real orders needs access to the franchise's ordering/POS system and franchisor approval.
- **Abuse:** anyone with the link can use up your free quota. For a public launch, add rate limiting.

## Ideas for next steps

- Add FAQs (catering, gift cards, loyalty program) as another JSON file + tool.
- "Is the store open right now?" tool using the hours and current Sydney time.
- Real ordering: a tool that hands the finished cart to the real order system.
- Rebuild the backend on AWS (API Gateway + Lambda + Terraform) for portfolio value.
