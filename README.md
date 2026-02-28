# Water Boiler UI

A custom web interface for your Toya smart water boiler switch (via SmartLife / Tuya IoT platform).

Features: 24h analog schedule clock, manual on/off, schedule editor, countdown timer.

---

## How it works

```
Your Phone/Browser  →  Cloudflare Tunnel  →  Raspberry Pi  →  Tuya Cloud API  →  Your Switch
```

The backend runs on your home server (Pi). Cloudflare Tunnel gives you a secure HTTPS URL accessible from anywhere — no port forwarding needed.

---

## Step 1 — Get Tuya API credentials

This only needs to be done once.

### 1.1 Register as a developer

1. Go to [developer.tuya.com](https://developer.tuya.com) and create a free account.
2. Complete email verification.

### 1.2 Create a Cloud Project

1. Log in → **Cloud** → **Development** → **Create Cloud Project**
2. Fill in:
   - Name: anything (e.g. "Home Boiler")
   - Industry: **Smart Home**
   - Development Method: **Custom**
   - Data Center: choose your region:
     - 🇮🇱 Israel / Middle East → **Central Europe Data Center**
     - 🇺🇸 Americas → **Western America Data Center**
3. On the next screen "Authorize API Services", scroll down and make sure these are subscribed:
   - **IoT Core**
   - **Device Status Notification**
   - Click **Authorize**

### 1.3 Get your Access ID and Secret

1. Go to your project → **Overview** tab
2. Copy **Access ID (Client ID)** and **Access Secret (Client Secret)**

### 1.4 Link your SmartLife account

1. In your project → **Devices** tab → **Link Tuya App Account**
2. Click **Add App Account**
3. Open the **SmartLife** app on your phone
4. Go to **Me** → scan the QR code shown on the Tuya dashboard
5. Your devices should appear under the project's device list

### 1.5 Find your Device ID

1. In the Tuya dashboard → **Devices** tab → find your water boiler switch
2. Copy the **Device ID** (a long alphanumeric string)

---

## Step 2 — Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```env
ACCESS_ID=your_access_id_here
ACCESS_SECRET=your_access_secret_here
DEVICE_ID=your_device_id_here
TUYA_REGION=eu          # use "eu" for Israel/Europe
PORT=3001
```

> **Region guide:**
> - Israel / Europe: `eu`
> - USA / Americas: `us`
> - China: `cn`
> - India: `in`

---

## Step 3 — Run the app

### Development (on your PC, to test first)

Open two terminals:

```bash
# Terminal 1 — backend
cd backend
npm start

# Terminal 2 — frontend dev server
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.
The Vite dev server proxies `/api` requests to the backend automatically.

### Production (on Raspberry Pi / home server)

```bash
# Build the frontend once
cd frontend
npm run build

# Start the backend (it also serves the built frontend)
cd backend
npm start
```

Open [http://localhost:3001](http://localhost:3001) — the full app is served from one port.

---

## Step 4 — Access from anywhere (Cloudflare Tunnel)

This gives you a permanent HTTPS URL so you can open the app from your phone anywhere.

### Install cloudflared on the Pi

```bash
# Raspberry Pi / Debian / Ubuntu
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb
```

> For 32-bit Pi use `cloudflared-linux-arm.deb`. For x86 use `cloudflared-linux-amd64.deb`.

### Authenticate

```bash
cloudflared tunnel login
# Opens a browser — log in to Cloudflare (free account is fine)
```

### Create a tunnel

```bash
cloudflared tunnel create boiler
cloudflared tunnel route dns boiler boiler.yourdomain.com
```

> You need a domain managed on Cloudflare. If you don't have one, use a free subdomain from services like [DuckDNS](https://www.duckdns.org/) or simply use the temporary `trycloudflare.com` URL (no account needed — see below).

### Quick option (no account needed)

```bash
# Run while backend is running on port 3001:
cloudflared tunnel --url http://localhost:3001
```

This prints a temporary HTTPS URL like `https://something.trycloudflare.com`. Works immediately, but the URL changes each restart.

### Run as a permanent service

```bash
# Create config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: boiler
credentials-file: /home/pi/.cloudflared/<your-tunnel-id>.json
ingress:
  - hostname: boiler.yourdomain.com
    service: http://localhost:3001
  - service: http_status:404
EOF

# Install as systemd service
sudo cloudflared service install
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
```

Now `https://boiler.yourdomain.com` always points to your Pi.

---

## Step 5 — Auto-start on Pi reboot

```bash
# Create a systemd service for the backend
sudo nano /etc/systemd/system/water-boiler.service
```

Paste:

```ini
[Unit]
Description=Water Boiler UI
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/water_switch_ui/backend
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable water-boiler
sudo systemctl start water-boiler
sudo systemctl status water-boiler
```

---

## Troubleshooting

### "Tuya API error [1010]" — token error
- Double-check your Access ID and Secret in `.env`
- Make sure the region matches where you created your cloud project

### "Tuya API error [2017]" — device not found
- Verify the Device ID in `.env`
- Make sure the SmartLife account is linked to your cloud project (Step 1.4)

### Toggle works but nothing happens to the physical switch
- The switch might use a different DP code. Check `rawDps` in the `/api/status` response:
  ```bash
  curl http://localhost:3001/api/status
  ```
- Look for the DP that changes when you manually toggle it in SmartLife. Update the `code` in `backend/src/routes/device.js` accordingly.

### Schedules return empty
- Not all device types support the Tuya timer API. If schedules fail, you can still use manual toggle and countdown.

---

## Project structure

```
water-switch-ui/
├── backend/
│   ├── src/
│   │   ├── server.js          Express app
│   │   ├── tuya.js            Tuya Cloud API client (no external deps)
│   │   └── routes/
│   │       ├── device.js      /api/status, /api/toggle
│   │       └── schedule.js    /api/schedules, /api/countdown
│   ├── .env                   Your credentials (never commit this)
│   ├── .env.example           Template
│   └── package.json
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── components/        All UI components
    │   └── hooks/
    │       └── useDeviceStatus.ts
    └── package.json
```
