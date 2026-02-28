import { createHmac, createHash } from "crypto";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l.includes("="))
    .map(l => l.trim().split("=").map(s => s.trim()))
);

const BASE_URL = "https://openapi.tuyaeu.com";
const { ACCESS_ID, ACCESS_SECRET, DEVICE_ID } = env;

async function getToken() {
  const t = String(Date.now()), n = Math.random().toString(36).slice(2);
  const sts = ["GET","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","","/v1.0/token?grant_type=1"].join("\n");
  const sig = createHmac("sha256", ACCESS_SECRET).update(ACCESS_ID+""+t+n+sts).digest("hex").toUpperCase();
  const r = await fetch(BASE_URL+"/v1.0/token?grant_type=1", {
    headers:{client_id:ACCESS_ID,sign:sig,t,nonce:n,sign_method:"HMAC-SHA256",access_token:""}
  });
  return (await r.json()).result.access_token;
}

const token = await getToken();

async function req(method, path, body) {
  const t = String(Date.now()), n = Math.random().toString(36).slice(2);
  const bs = body ? JSON.stringify(body) : null;
  const bh = bs ? createHash("sha256").update(bs).digest("hex") : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const sig = createHmac("sha256", ACCESS_SECRET).update(ACCESS_ID+token+t+n+[method,bh,"",path].join("\n")).digest("hex").toUpperCase();
  const r = await fetch(BASE_URL+path, {
    method, body: bs,
    headers:{client_id:ACCESS_ID,access_token:token,sign:sig,t,nonce:n,sign_method:"HMAC-SHA256","Content-Type":"application/json"}
  });
  return r.json();
}

// The SmartLife schedule sets countdown_1 (seconds) at a specific time+day,
// NOT switch_1=true. Test all countdown-based timer formats:
const BASE = `/v1.0/devices/${DEVICE_ID}/timers`;
const TOMORROW_TIME = (() => {
  const d = new Date(Date.now() + 60000); // 1 min from now for quick test
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
})();
console.log("Testing with time:", TOMORROW_TIME);

const tests = [
  // countdown_1 as code array
  { loops:"1111111", time:TOMORROW_TIME, dps:[{code:"countdown_1",value:3600}] },
  // countdown_1 as JSON-stringified array
  { loops:"1111111", time:TOMORROW_TIME, dps:`[{"code":"countdown_1","value":3600}]` },
  // countdown_1 as JSON-stringified object
  { loops:"1111111", time:TOMORROW_TIME, dps:`{"countdown_1":3600}` },
  // Both switch_1 + countdown_1 together
  { loops:"1111111", time:TOMORROW_TIME, dps:[{code:"switch_1",value:true},{code:"countdown_1",value:3600}] },
  // switch_1 true + countdown_1 as stringified
  { loops:"1111111", time:TOMORROW_TIME, dps:`[{"code":"switch_1","value":true},{"code":"countdown_1","value":3600}]` },
  // Sunday-only, 16:00, 3600s (exactly as user described SmartLife)
  { loops:"0000001", time:"16:00", dps:[{code:"countdown_1",value:3600}] },
  { loops:"0000001", time:"16:00", dps:`[{"code":"countdown_1","value":3600}]` },
];

for (const body of tests) {
  const r = await req("POST", BASE, body);
  const label = JSON.stringify(body).slice(0,80);
  if (r.success) {
    console.log("SUCCESS:", label);
    console.log("Result:", JSON.stringify(r.result));
    // Read back what was created
    const list = await req("GET", BASE);
    console.log("Timer list after create:", JSON.stringify(list.result));
    // Delete it
    const id = r.result?.timer_id ?? r.result;
    if (id) { await req("DELETE", `${BASE}/${id}`); console.log("Deleted", id); }
    break;
  } else {
    console.log(`[${r.code}]`, label.slice(0,70));
  }
}
