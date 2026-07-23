import { useEffect, useRef, useState } from "react";

/**
 * Full-screen confetti + banner shown when a lead converts to a client.
 * Dependency-free canvas confetti (two side cannons), auto-dismisses.
 */
const COLORS = ["#2e7dd1", "#187a4b", "#f79b32", "#8fc1f2", "#142a4c", "#ffd166"];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  rot: number;
  vrot: number;
  shape: 0 | 1; // rect | circle
}

export default function Celebration({
  name,
  onDone,
}: {
  name: string;
  onDone: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const particles: Particle[] = [];
    const launch = (originX: number, angle: number) => {
      for (let i = 0; i < 90; i++) {
        const spread = angle + (Math.random() - 0.5) * 0.7;
        const speed = 9 + Math.random() * 9;
        particles.push({
          x: originX,
          y: H * 0.62,
          vx: Math.cos(spread) * speed,
          vy: Math.sin(spread) * speed - 4,
          size: 5 + Math.random() * 6,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          rot: Math.random() * Math.PI,
          vrot: (Math.random() - 0.5) * 0.3,
          shape: Math.random() > 0.5 ? 0 : 1,
        });
      }
    };
    // Two cannons firing inward-up from the lower corners.
    launch(0, -Math.PI / 3);
    launch(W, (-Math.PI * 2) / 3);
    // A center burst a beat later.
    const burst = setTimeout(() => launch(W / 2, -Math.PI / 2), 250);

    let raf = 0;
    const start = performance.now();
    const DURATION = 3400;

    const tick = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        p.vy += 0.22; // gravity
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        const fade = Math.max(0, 1 - Math.max(0, elapsed - 1800) / 1600);
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 0) {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (elapsed < DURATION) {
        raf = requestAnimationFrame(tick);
      } else {
        setLeaving(true);
        setTimeout(onDone, 400);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(burst);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`celebrate-overlay${leaving ? " leaving" : ""}`}
      onClick={() => {
        setLeaving(true);
        setTimeout(onDone, 300);
      }}
    >
      <canvas ref={canvasRef} className="celebrate-canvas" />
      <div className="celebrate-card">
        <div className="celebrate-emoji">🎉</div>
        <h2>Converted to Client!</h2>
        <p className="muted small">
          {name} is now a client. Nicely done.
        </p>
      </div>
    </div>
  );
}
