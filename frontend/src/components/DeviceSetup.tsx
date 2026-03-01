import { useState, useEffect, useRef, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import styles from "./DeviceSetup.module.css";

interface Device {
  deviceId: string;
  name: string;
  category: string;
  isOnline: boolean;
  homeId: string;
  homeName: string;
}

type Step = "userCode" | "qrCode" | "selectDevice";

interface Props {
  onComplete: () => void;
}

export function DeviceSetup({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("userCode");
  const [userCode, setUserCode] = useState("");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPolling(false);
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function startPolling(token: string, code: string) {
    setPolling(true);
    setError(null);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/setup/qr-poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, userCode: code }),
        });
        const data = await res.json();

        if (data.status === "success") {
          stopPolling();
          setDevices(data.devices || []);
          setStep("selectDevice");
        }
        // "pending" → keep polling
      } catch (err) {
        stopPolling();
        setError(err instanceof Error ? err.message : "Polling failed");
      }
    }, 3000);
  }

  async function handleGenerateQR(e: React.FormEvent) {
    e.preventDefault();
    const code = userCode.trim();
    if (!code) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/qr-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to generate QR code");

      setQrCodeUrl(data.qrCodeUrl);
      setStep("qrCode");

      // Start polling immediately with the token from this response
      startPolling(data.token, code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error generating QR code");
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectDevice(device: Device) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/select-device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: device.deviceId,
          homeId: device.homeId,
          deviceName: device.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save device");
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving device");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h2 className={styles.heading}>Connect Your Device</h2>
        <p className={styles.subtitle}>
          Link your SmartLife account to control your water switch.
        </p>

        <div className={styles.steps}>
          <div className={`${styles.stepDot} ${step === "userCode" ? styles.active : styles.done}`}>1</div>
          <div className={styles.stepLine} />
          <div className={`${styles.stepDot} ${step === "qrCode" ? styles.active : step === "selectDevice" ? styles.done : ""}`}>2</div>
          <div className={styles.stepLine} />
          <div className={`${styles.stepDot} ${step === "selectDevice" ? styles.active : ""}`}>3</div>
        </div>

        {step === "userCode" && (
          <form onSubmit={handleGenerateQR} className={styles.stepContent}>
            <div className={styles.instructions}>
              <span className={styles.instructionLabel}>Find your User Code</span>
              <ol className={styles.instructionList}>
                <li>Open the <strong>SmartLife</strong> app</li>
                <li>Go to <strong>Me</strong> tab</li>
                <li>Tap <strong>Settings</strong> (gear icon)</li>
                <li>Tap <strong>Account and Security</strong></li>
                <li>Find <strong>User Code</strong> and copy it</li>
              </ol>
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Enter your User Code"
              value={userCode}
              onChange={(e) => setUserCode(e.target.value)}
              disabled={loading}
              autoFocus
            />
            <button
              type="submit"
              className={styles.primaryButton}
              disabled={loading || !userCode.trim()}
            >
              {loading ? "Generating..." : "Generate QR Code"}
            </button>
          </form>
        )}

        {step === "qrCode" && (
          <div className={styles.stepContent}>
            <div className={styles.qrContainer}>
              <QRCodeSVG value={qrCodeUrl} size={200} />
            </div>
            <div className={styles.instructions}>
              <span className={styles.instructionLabel}>Scan with SmartLife</span>
              <ol className={styles.instructionList}>
                <li>Open <strong>SmartLife</strong> app</li>
                <li>Tap the <strong>scan</strong> icon (top right)</li>
                <li>Scan this QR code</li>
                <li>Tap <strong>Confirm Login</strong></li>
              </ol>
            </div>
            {polling && (
              <div className={styles.pollingBar}>
                <div className={styles.spinnerSmall} />
                <span>Waiting for confirmation...</span>
              </div>
            )}
            <button
              className={styles.secondaryButton}
              onClick={() => { stopPolling(); setStep("userCode"); setError(null); }}
            >
              Back
            </button>
          </div>
        )}

        {step === "selectDevice" && (
          <div className={styles.stepContent}>
            <span className={styles.instructionLabel}>Select your device</span>
            {devices.length === 0 ? (
              <p className={styles.noDevices}>
                No devices found. Make sure your device is added in the SmartLife app.
              </p>
            ) : (
              <div className={styles.deviceGrid}>
                {devices.map((d) => (
                  <button
                    key={d.deviceId}
                    className={styles.deviceCard}
                    onClick={() => handleSelectDevice(d)}
                    disabled={loading}
                  >
                    <span className={styles.deviceName}>{d.name}</span>
                    <span className={styles.deviceMeta}>
                      {d.homeName}
                    </span>
                    <span className={`${styles.deviceStatus} ${d.isOnline ? styles.online : styles.offline}`}>
                      {d.isOnline ? "Online" : "Offline"}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              className={styles.secondaryButton}
              onClick={() => { setStep("userCode"); setError(null); }}
            >
              Start Over
            </button>
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
}
