document.addEventListener('DOMContentLoaded', () => {
  const pattern = document.createElement('div');
  pattern.className = 'paw-pattern';
  pattern.setAttribute('aria-hidden', 'true');
  document.body.prepend(pattern);
  const patternSeed = Math.floor(Math.random() * 2147483646) + 1;

  function renderPaws() {
    pattern.replaceChildren();
    const pageHeight = Math.max(document.body.scrollHeight, window.innerHeight);
    const pageWidth = window.innerWidth;
    const pawCount = Math.ceil(pageWidth * pageHeight / (260 * 260));
    const placed = [];
    let seed = patternSeed;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    for (let attempt = 0; attempt < pawCount * 80 && placed.length < pawCount; attempt++) {
      const size = Math.min(84 + random() * 76, (pageWidth - 32) / Math.SQRT2);
      const radius = size / Math.SQRT2;
      const left = radius + 8 + random() * (pageWidth - 2 * (radius + 8));
      const top = radius + 8 + random() * (pageHeight - 2 * (radius + 8));
      if (placed.some(paw => Math.hypot(left - paw.left, top - paw.top) < radius + paw.radius + 12)) continue;

      const paw = document.createElement('span');
      paw.style.top = `${top}px`;
      paw.style.left = `${left}px`;
      paw.style.setProperty('--paw-size', `${size}px`);
      paw.style.setProperty('--paw-rotation', `${Math.round(random() * 140 - 70)}deg`);
      paw.style.setProperty('--paw-flip', random() > 0.5 ? '-1' : '1');
      pattern.append(paw);
      placed.push({ left, top, radius });
    }
  }

  const headings = document.querySelectorAll('.section-block > h2');

  function renderHeadingPaws() {
    let seed = patternSeed;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    headings.forEach(heading => {
      heading.querySelectorAll('.title-paw').forEach(paw => paw.remove());
      const count = Math.max(1, Math.floor(heading.clientWidth / 200));
      for (let index = 0; index < count; index++) {
        const paw = document.createElement('span');
        paw.className = 'title-paw';
        paw.setAttribute('aria-hidden', 'true');
        paw.style.left = `${((index + 0.35 + random() * 0.3) / count) * 100}%`;
        paw.style.top = `${20 + random() * 60}%`;
        paw.style.setProperty('--paw-size', `${68 + random() * 44}px`);
        paw.style.setProperty('--paw-rotation', `${Math.round(random() * 140 - 70)}deg`);
        paw.style.setProperty('--paw-flip', random() > 0.5 ? '-1' : '1');
        heading.append(paw);
      }
    });
  }

  renderPaws();
  renderHeadingPaws();
  new ResizeObserver(renderPaws).observe(document.body);
  const headingObserver = new ResizeObserver(renderHeadingPaws);
  headings.forEach(heading => headingObserver.observe(heading));
});
