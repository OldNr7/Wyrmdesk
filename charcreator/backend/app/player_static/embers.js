// Glut, die langsam aufsteigt, wie auf wyrmdesk.ch. Nur Dekoration: hinter allem, ohne Klicks,
// aus bei "weniger Bewegung" und während das Blatt gedruckt wird.
(() => {
  const canvas = document.getElementById("embers");
  if (!canvas || !canvas.getContext || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, sparks = [];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(60, (w * h) / 26000));
    sparks = Array.from({ length: count }, () => spark(true));
  }

  function spark(anywhere) {
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      r: 0.6 + Math.random() * 1.8,
      vy: 0.25 + Math.random() * 0.7,
      drift: Math.random() * Math.PI * 2,
      life: 0.4 + Math.random() * 0.6,
    };
  }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const s of sparks) {
      s.y -= s.vy;
      s.drift += 0.012;
      s.x += Math.sin(s.drift) * 0.35;
      const fade = Math.max(0, Math.min(1, s.y / h)) * s.life;
      if (s.y < -10) Object.assign(s, spark(false));
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 4);
      g.addColorStop(0, `rgba(255, 200, 140, ${0.9 * fade})`);
      g.addColorStop(0.4, `rgba(224, 112, 95, ${0.45 * fade})`);
      g.addColorStop(1, "rgba(224, 112, 95, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!document.hidden) requestAnimationFrame(frame);
  }

  resize();
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) requestAnimationFrame(frame); });
  requestAnimationFrame(frame);
})();
