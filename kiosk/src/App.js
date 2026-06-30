import { useEffect, useMemo, useState } from "react";
import AdminView from "./AdminView";
import "./App.css";

// ── Web Audio feedback ──────────────────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  try {
    if (!_audioCtx) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _audioCtx;
  } catch {
    return null;
  }
}

function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;

    if (type === "click") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.06);
      gain.gain.setValueAtTime(0.07, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.start(t);
      osc.stop(t + 0.08);
    } else if (type === "success-in" || type === "success-out") {
      const freqs = type === "success-in" ? [523, 659, 784] : [659, 784, 523];
      freqs.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.value = freq;
        const s = t + i * 0.1;
        gain.gain.setValueAtTime(0, s);
        gain.gain.linearRampToValueAtTime(0.055, s + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, s + 0.32);
        osc.start(s);
        osc.stop(s + 0.36);
      });
    }
  } catch {
    // audio blocked or unavailable — continue silently
  }
}
// ── End Web Audio ───────────────────────────────────────────────────────────

const API_BASE_URL = "/api";
const TZ = "America/Edmonton"; // Banff, Alberta — Mountain Time
const WEATHER_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=51.1784&longitude=-115.5708&current=temperature_2m,weather_code&timezone=auto&forecast_days=1";
const LOGO_SRC = "/logo.png";
const MOUNTAIN_OVERLAY_SRC = "/mountain-overlay.png";

const WEATHER_CODE_MAP = {
  0: { label: "Clear", effect: "clear" },
  1: { label: "Mostly clear", effect: "clear" },
  2: { label: "Partly cloudy", effect: "clear" },
  3: { label: "Cloudy", effect: "clear" },
  45: { label: "Fog", effect: "clear" },
  48: { label: "Fog", effect: "clear" },
  51: { label: "Light drizzle", effect: "rain" },
  53: { label: "Drizzle", effect: "rain" },
  55: { label: "Heavy drizzle", effect: "rain" },
  56: { label: "Freezing drizzle", effect: "snow" },
  57: { label: "Freezing drizzle", effect: "snow" },
  61: { label: "Light rain", effect: "rain" },
  63: { label: "Rain", effect: "rain" },
  65: { label: "Heavy rain", effect: "rain" },
  66: { label: "Freezing rain", effect: "snow" },
  67: { label: "Freezing rain", effect: "snow" },
  71: { label: "Light snow", effect: "snow" },
  73: { label: "Snow", effect: "snow" },
  75: { label: "Heavy snow", effect: "snow" },
  77: { label: "Snow grains", effect: "snow" },
  80: { label: "Rain showers", effect: "rain" },
  81: { label: "Rain showers", effect: "rain" },
  82: { label: "Heavy showers", effect: "rain" },
  85: { label: "Snow showers", effect: "snow" },
  86: { label: "Snow showers", effect: "snow" },
  95: { label: "Thunderstorm", effect: "rain" },
  96: { label: "Storm and hail", effect: "rain" },
  99: { label: "Storm and hail", effect: "rain" },
};

function getWeatherDetails(code) {
  return WEATHER_CODE_MAP[code] || { label: "Weather unavailable", effect: "clear" };
}

function StepRail({ currentStep, selectedEmployee }) {
  const steps = [
    { id: 1, label: "Select employee" },
    { id: 2, label: "Enter PIN" },
    { id: 3, label: "Choose action" },
  ];

  return (
    <div className="kiosk-step-rail">
      <div className="kiosk-step-list">
        {steps.map((step) => (
          <div
            key={step.id}
            className={`kiosk-step-pill ${currentStep === step.id ? "is-active" : ""}`}
          >
            <span className="kiosk-step-index">0{step.id}</span>
            <span>{step.label}</span>
          </div>
        ))}
      </div>
      {selectedEmployee ? (
        <div className="kiosk-selected-employee">
          <span className="kiosk-selected-label">Selected employee</span>
          <span className="kiosk-selected-name">{selectedEmployee.name}</span>
        </div>
      ) : null}
    </div>
  );
}

function StatusNotice({ tone, message }) {
  if (!message) {
    return null;
  }

  return (
    <div className={`kiosk-status-notice ${tone === "error" ? "is-error" : "is-success"}`}>
      {message}
    </div>
  );
}

function WeatherPanel({ weather }) {
  return (
    <div className="kiosk-top-card">
      <div className="kiosk-top-label">Banff, Canada</div>
      <div className="kiosk-weather-temp">{weather.temperature}</div>
      <div className="kiosk-weather-condition">{weather.condition}</div>
    </div>
  );
}

function ClockPanel({ now }) {
  return (
    <div className="kiosk-top-card kiosk-top-card-right">
      <div className="kiosk-top-label">
        {new Intl.DateTimeFormat("en-CA", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: TZ,
        }).format(now)}
      </div>
      <div className="kiosk-clock-time">
        {new Intl.DateTimeFormat("en-CA", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: TZ,
        }).format(now)}
      </div>
      <div className="kiosk-weather-condition">
        {new Intl.DateTimeFormat("en-CA", {
          year: "numeric",
          timeZone: TZ,
        }).format(now)}
      </div>
    </div>
  );
}

function AmbientWeather({ effect }) {
  const particles = useMemo(
    () => {
      const count = effect === "snow" ? 18 : effect === "rain" ? 12 : 0;

      return Array.from({ length: count }, (_, index) => {
        const baseLeft = 4 + ((index * 5.5) % 92);
        const isSnow = effect === "snow";

        return {
          id: index,
          left: `${baseLeft}%`,
          delay: `${(index % 7) * (isSnow ? 1.1 : 0.7)}s`,
          duration: `${isSnow ? 10 + (index % 5) * 1.45 : 7.5 + (index % 4) * 0.9}s`,
          opacity: isSnow ? 0.14 + (index % 4) * 0.04 : 0.1 + (index % 3) * 0.04,
          drift: `${(index % 2 === 0 ? -1 : 1) * (0.3 + (index % 3) * 0.22)}rem`,
          scale: isSnow ? 0.95 + (index % 3) * 0.22 : 1,
          blur: isSnow ? `${0.7 + (index % 2) * 0.4}px` : "0px",
        };
      });
    },
    [effect],
  );

  if (effect === "clear") {
    return null;
  }

  return (
    <div className={`kiosk-weather-layer is-${effect}`} aria-hidden="true">
      {particles.map((particle) => (
        <span
          key={particle.id}
          className="kiosk-weather-particle"
          style={{
            left: particle.left,
            animationDelay: particle.delay,
            animationDuration: particle.duration,
            opacity: particle.opacity,
            "--particle-drift": particle.drift,
            "--particle-scale": particle.scale,
            "--particle-blur": particle.blur,
          }}
        />
      ))}
    </div>
  );
}

function EmployeeGrid({ employees, onSelect }) {
  return (
    <div className="kiosk-employee-grid">
      {employees.map((employee) => (
        <button
          key={employee.id}
          onClick={() => { playSound("click"); onSelect(employee); }}
          className="kiosk-employee-card"
        >
          <span className="kiosk-employee-name">{employee.name}</span>
        </button>
      ))}
    </div>
  );
}

function PinPad({ pin, onDigit, onBack, onDelete, employeeName }) {
  const buttons = [1, 2, 3, 4, 5, 6, 7, 8, 9, "Back", 0, "Delete"];

  return (
    <div className="kiosk-flow-content">
      {employeeName ? (
        <p className="kiosk-pin-for">PIN for <strong>{employeeName}</strong></p>
      ) : null}
      <div className="kiosk-pin-display">{(pin || "  ").replace(/./g, "•")}</div>
      <div className="kiosk-keypad-grid">
        {buttons.map((button) => (
          <button
            key={button}
            onClick={() => {
              playSound("click");
              if (button === "Back") {
                onBack();
                return;
              }
              if (button === "Delete") {
                onDelete();
                return;
              }
              onDigit(String(button));
            }}
            className={`kiosk-keypad-button ${typeof button === "string" ? "is-secondary" : ""}`}
          >
            {button}
          </button>
        ))}
      </div>
    </div>
  );
}

function ActionPanel({ onCheckIn, onCheckOut, onBack }) {
  return (
    <div className="kiosk-flow-content">
      <button
        onClick={() => { playSound("click"); onCheckIn(); }}
        className="kiosk-action-button is-checkin"
      >
        Check-in
      </button>
      <button
        onClick={() => { playSound("click"); onCheckOut(); }}
        className="kiosk-action-button is-checkout"
      >
        Check-out
      </button>
      <button onClick={onBack} className="kiosk-action-link">
        Back
      </button>
    </div>
  );
}

function SuccessOverlay({ type, employeeName, now }) {
  const isCheckIn = type === "in";
  const timeStr = new Intl.DateTimeFormat("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  }).format(now || new Date());

  return (
    <div className={`kiosk-success-overlay ${isCheckIn ? "is-checkin" : "is-checkout"}`}>
      <div className="kiosk-success-check">✓</div>
      <div className="kiosk-success-title">
        {isCheckIn ? "Check-in complete" : "Check-out complete"}
      </div>
      <div className="kiosk-success-name">{employeeName}</div>
      <div className="kiosk-success-time">{timeStr}</div>
    </div>
  );
}

function KioskView() {
  const [screen, setScreen] = useState("employee");
  const [employees, setEmployees] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState({ tone: "", message: "" });
  const [successType, setSuccessType] = useState(null);
  const [isLoadingEmployees, setIsLoadingEmployees] = useState(true);
  const [employeesError, setEmployeesError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [weather, setWeather] = useState({
    temperature: "--°C",
    condition: "Loading weather",
    effect: "clear",
  });

  useEffect(() => {
    let isMounted = true;

    async function loadEmployees() {
      setIsLoadingEmployees(true);
      setEmployeesError("");

      try {
        const response = await fetch(`${API_BASE_URL}/employees`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to load employees.");
        }

        if (isMounted) {
          setEmployees(data);
        }
      } catch (error) {
        if (isMounted) {
          setEmployeesError(error.message || "Unable to connect to the server.");
        }
      } finally {
        if (isMounted) {
          setIsLoadingEmployees(false);
        }
      }
    }

    loadEmployees();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadWeather() {
      try {
        const response = await fetch(WEATHER_URL);
        const data = await response.json();
        const current = data.current || {};
        const details = getWeatherDetails(current.weather_code);

        if (isMounted) {
          setWeather({
            temperature:
              typeof current.temperature_2m === "number"
                ? `${Math.round(current.temperature_2m)}°C`
                : "--°C",
            condition: details.label,
            effect: details.effect,
          });
        }
      } catch {
        if (isMounted) {
          setWeather({
            temperature: "--°C",
            condition: "Weather unavailable",
            effect: "clear",
          });
        }
      }
    }

    loadWeather();
    const intervalId = window.setInterval(loadWeather, 15 * 60 * 1000);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const currentStep =
    screen === "employee" ? 1 : screen === "pin" ? 2 : screen === "action" ? 3 : 3;

  const vibrate = () => {
    if (navigator.vibrate) {
      navigator.vibrate(40);
    }
  };

  const resetFlow = () => {
    setScreen("employee");
    setSelectedEmployee(null);
    setPin("");
    setStatus({ tone: "", message: "" });
    setSuccessType(null);
  };

  const goToPinStep = (employee) => {
    vibrate();
    setSelectedEmployee(employee);
    setPin("");
    setStatus({ tone: "", message: "" });
    setScreen("pin");
  };

  const handlePinInput = (value) => {
    if (value === "delete") {
      setPin((current) => current.slice(0, -1));
      return;
    }

    setStatus((current) => (current.tone === "error" ? { tone: "", message: "" } : current));

    if (pin.length >= 2) {
      return;
    }

    const nextPin = `${pin}${value}`;
    setPin(nextPin);

    if (nextPin.length === 2) {
      window.setTimeout(() => setScreen("action"), 140);
    }
  };

  const submitTimeRecord = async (type) => {
    if (!selectedEmployee?.id) {
      setStatus({ tone: "error", message: "Invalid employee" });
      resetFlow();
      return;
    }

    if (pin.length < 2) {
      setStatus({ tone: "error", message: "Enter PIN" });
      setScreen("pin");
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/time`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          employee_id: selectedEmployee.id,
          pin,
          type,
          kiosk_id: "banff-01",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          setStatus({ tone: "error", message: "Invalid PIN" });
          setPin("");
          setScreen("pin");
          return;
        }

        setStatus({
          tone: "error",
          message: data.error || "Unable to complete this action.",
        });
        return;
      }

      setSuccessType(type);
      setStatus({ tone: "", message: "" });
      setScreen("success");
      playSound(type === "in" ? "success-in" : "success-out");

      window.setTimeout(() => {
        resetFlow();
      }, 2200);
    } catch {
      setStatus({
        tone: "error",
        message: "Unable to connect to the server.",
      });
      setPin("");
      setScreen("pin");
    }
  };

  const renderMainContent = () => {
    if (isLoadingEmployees) {
      return <div className="kiosk-empty-state">Loading employees…</div>;
    }

    if (employeesError) {
      return (
        <div className="kiosk-empty-state">
          <StatusNotice tone="error" message={employeesError} />
          <button onClick={() => window.location.reload()} className="kiosk-action-link">
            Try again
          </button>
        </div>
      );
    }

    if (screen === "employee") {
      return <EmployeeGrid employees={employees} onSelect={goToPinStep} />;
    }

    if (screen === "pin") {
      return (
        <PinPad
          pin={pin}
          employeeName={selectedEmployee?.name}
          onDigit={(value) => {
            vibrate();
            handlePinInput(value);
          }}
          onBack={() => {
            vibrate();
            resetFlow();
          }}
          onDelete={() => {
            vibrate();
            handlePinInput("delete");
          }}
        />
      );
    }

    if (screen === "action") {
      return (
        <ActionPanel
          onCheckIn={() => submitTimeRecord("in")}
          onCheckOut={() => submitTimeRecord("out")}
          onBack={() => {
            setScreen("pin");
            setStatus({ tone: "", message: "" });
          }}
        />
      );
    }

    if (screen === "success") {
      return (
        <SuccessOverlay
          type={successType}
          employeeName={selectedEmployee?.name}
          now={now}
        />
      );
    }

    return (
      <div className="kiosk-empty-state">
        <StatusNotice tone={status.tone} message={status.message} />
      </div>
    );
  };

  return (
    <div className="kiosk-shell">
      <AmbientWeather effect={weather.effect} />
      <div className="kiosk-sky-gradient" aria-hidden="true" />
      <div className="kiosk-stage">
        <header className="kiosk-topbar">
          <WeatherPanel weather={weather} />
          <div className="kiosk-logo-wrap">
            <img src={LOGO_SRC} alt="Restaurant logo" className="kiosk-logo" />
          </div>
          <ClockPanel now={now} />
        </header>

        <main className="kiosk-main-card">
          <StepRail currentStep={currentStep} selectedEmployee={selectedEmployee} />
          <div className="kiosk-content-shell">
            <StatusNotice tone={status.tone} message={status.message} />
            <div className={status.message ? "kiosk-content with-status" : "kiosk-content"}>
              {renderMainContent()}
            </div>
          </div>
        </main>
      </div>

      <div className="kiosk-mountain-wrap" aria-hidden="true">
        <img src={MOUNTAIN_OVERLAY_SRC} alt="" className="kiosk-mountain-image" />
      </div>

      <button
        className="kiosk-admin-link"
        onClick={() => { window.location.href = "/admin"; }}
        aria-label="Go to admin panel"
      >
        Admin
      </button>
    </div>
  );
}

function App() {
  const isAdminRoute = window.location.pathname.startsWith("/admin");
  return isAdminRoute ? <AdminView /> : <KioskView />;
}

export default App;
