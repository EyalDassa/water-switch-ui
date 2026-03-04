# Water Boiler UI

A smarter way to control your water boiler. No more fumbling through the SmartLife app — just open a link and you're in.

Built for any Tuya/SmartLife-compatible smart switch. Runs on a Raspberry Pi at home and gives you a clean, fast web app accessible from anywhere.

**Try it out:** [boiler.parligator.com](https://boiler.parligator.com)

---

## Features

### See your whole day at a glance

A 24-hour analog clock shows when the boiler is scheduled to run, when it actually ran, and whether it's on right now — all in one view.

### One-tap control

Toggle the boiler on or off instantly. Need hot water in 30 minutes? Set a quick timer and forget about it.

### Smart schedules

Create recurring schedules with custom colors. The clock face lights up with colored arcs so you can see your hot water windows without reading a single number.

### Activity history

See the last 10 sessions — when they started, how long they ran, and whether they were triggered by a schedule, a manual tap, a timer, or directly from SmartLife.

### Household sharing

Invite family members by email. Everyone gets their own login and can control the boiler. The admin sees who did what and when.

- Admin sets up the device once, then invites members
- Members can toggle, set timers, and view history
- Admin can rename the device (syncs everywhere, including Tuya)
- Admin can grant invite permissions to members
- Activity log shows which member triggered each action

### Works from anywhere

Runs behind a Cloudflare Tunnel, so you get a secure HTTPS link that works from any phone or browser, anywhere in the world.

---

## Want to run your own?

This project is fully open source. If you have a Tuya-compatible smart switch, you can fork this repo and set it up for yourself.

### What you'll need

- A smart switch connected to the [SmartLife](https://www.tuya.com/product/1694661057) app
- A Raspberry Pi (or any always-on machine with Node.js 18+)
- A free [Tuya developer account](https://developer.tuya.com) for API access
- A free [Clerk account](https://clerk.com) for user authentication
- (Optional) A Cloudflare domain for remote access

### Quick start

```bash
git clone https://github.com/EyalDassa/water-switch-ui.git
cd water-switch-ui
cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

Copy the example env file and fill in your credentials:

```bash
cp backend/.env.example backend/.env
```

```env
ACCESS_ID=your_tuya_access_id
ACCESS_SECRET=your_tuya_access_secret
DEVICE_ID=your_device_id
TUYA_REGION=eu                              # eu, us, cn, or in
PORT=3001
CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
APP_URL=https://boiler.yourdomain.com       # for invite email redirects
```

```bash
echo "VITE_CLERK_PUBLISHABLE_KEY=pk_live_..." > frontend/.env
```

**Development:**

```bash
cd backend && npm run dev     # Terminal 1
cd frontend && npm run dev    # Terminal 2 — opens on :5173
```

**Production:**

```bash
cd frontend && npm run build
cd backend && npm run build && npm start    # Serves everything on :3001
```

### Getting Tuya API credentials

1. Go to [developer.tuya.com](https://developer.tuya.com) → **Cloud** → **Development** → **Create Cloud Project**
   - Industry: Smart Home, Development Method: Custom
   - Data Center: pick your region (Central Europe for Israel/EU, Western America for US, etc.)
   - Authorize **IoT Core** and **Device Status Notification** APIs
2. Copy your **Access ID** and **Access Secret**
3. **Devices** tab → **Link Tuya App Account** → scan the QR code with your SmartLife app
4. Find your switch and copy its **Device ID**

### Remote access with Cloudflare Tunnel

```bash
# Install on your Pi
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb

# Quick test (temporary URL)
cloudflared tunnel --url http://localhost:3001

# Permanent setup
cloudflared tunnel login
cloudflared tunnel create boiler
cloudflared tunnel route dns boiler boiler.yourdomain.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### Auto-start on boot

Create `/etc/systemd/system/water-boiler.service`:

```ini
[Unit]
Description=Water Boiler UI
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/water-switch-ui/backend
ExecStart=/usr/bin/node dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now water-boiler
```

---

## Troubleshooting

| Problem                                    | Fix                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Tuya API error [1010]                      | Check Access ID/Secret and region setting                                     |
| Tuya API error [2017]                      | Verify Device ID; make sure SmartLife account is linked to your cloud project |
| Toggle works in UI but switch doesn't move | Different DP code — check `rawDps` in `/api/status` response                  |
| Schedules empty                            | Not all devices support the Tuya timer API                                    |

---

## Tech stack

| Layer      | Tech                                                   |
| ---------- | ------------------------------------------------------ |
| Frontend   | React, TypeScript, Vite, CSS Modules                   |
| Backend    | Node.js, Express                                       |
| Auth       | Clerk (email + OAuth)                                  |
| Device API | Custom Tuya Cloud client (HMAC-SHA256 signing, no SDK) |
| Hosting    | Raspberry Pi + Cloudflare Tunnel                       |

No database — all device state lives in Tuya, user/team data lives in Clerk metadata.

---

## Project structure

```
water-switch-ui/
├── backend/src/
│   ├── server.js              Express app
│   ├── tuya.js                Tuya Cloud API client
│   ├── sharing.js             Tuya Device Sharing (QR login)
│   ├── events.js              SSE + background polling
│   ├── actionTracker.js       UI action attribution
│   ├── middleware/
│   │   └── deviceConfig.js    Per-user Tuya client
│   └── routes/
│       ├── device.js          Status, toggle, history
│       ├── schedule.js        Schedules, countdown
│       ├── team.js            Household management
│       └── setup.js           QR login + device setup
└── frontend/src/
    ├── App.tsx
    ├── components/            Clock, status, toggle, timer, schedules,
    │                          history, setup, household panel, invite modal
    └── hooks/
        └── useDeviceStatus.ts
```
