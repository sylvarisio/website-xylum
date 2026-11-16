/* xylum.io — the small script behind the site's moving pictures (site kit v5).

   Every page reads in full without it: each picture is written into the HTML in its
   finished state, and the form on the signup page is a plain form. This file only
   makes the pictures move and the pickers pick. It asks no other server for anything
   and stores nothing.

   One clock, as the kit draws it: a tick every 700ms. With "reduce motion" switched on
   nothing ticks, and the pictures stay as the HTML wrote them. */
(function () {
  'use strict';

  var TICK = 700;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var t = 0;
  var steps = [];

  function all(root, selector) {
    return Array.prototype.slice.call(root.querySelectorAll(selector));
  }
  function each(selector, fn) {
    all(document, selector).forEach(fn);
  }
  function press(buttons, index) {
    buttons.forEach(function (button, i) {
      var on = i === index;
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (button.classList.contains('btn')) button.classList.toggle('secondary', !on);
      else button.classList.toggle('on', on);
    });
  }

  /* The hero: three plates in one place. It moves on every 7 ticks; a pick by hand
     holds for 20 ticks. The icons beside it light for the apps that sentence read. */
  each('[data-hero]', function (root) {
    var plates = all(root, '.plate');
    var buttons = all(root, '.pickrow button');
    var icons = all(root, 'img[data-app]');
    var picked = -1;
    var until = 0;
    var shown = -1;
    function show(index) {
      if (index === shown) return;
      shown = index;
      var lit = (plates[index].getAttribute('data-lit') || '').split(' ');
      plates.forEach(function (plate, i) {
        plate.classList.toggle('on', i === index);
        plate.inert = i !== index;
      });
      icons.forEach(function (icon) {
        icon.classList.toggle('lit', lit.indexOf(icon.getAttribute('data-app')) !== -1);
      });
      press(buttons, index);
    }
    buttons.forEach(function (button, i) {
      button.addEventListener('click', function () {
        picked = i;
        until = t + 20;
        show(i);
      });
    });
    steps.push(function () {
      show(picked >= 0 && t < until ? picked : Math.floor(t / 7) % plates.length);
    });
  });

  /* "The real thing": three captures in one frame. Opens on the second. */
  each('[data-shots]', function (frame) {
    var buttons = all(frame.previousElementSibling, 'button');
    buttons.forEach(function (button, i) {
      button.addEventListener('click', function () {
        frame.setAttribute('data-on', String(i));
        press(buttons, i);
      });
    });
  });

  /* The chores: a 10-tick loop. Row n is done on tick n+1; all four hold to the end. */
  each('[data-chores]', function (root) {
    var rows = all(root, 'li');
    var count = root.querySelector('.count');
    steps.push(function () {
      var c = t % 10;
      rows.forEach(function (row, i) { row.classList.toggle('done', c > i); });
      count.textContent = Math.min(c, rows.length) + ' of ' + rows.length + ' done';
    });
  });

  /* The reminder: the tone steps every 6 ticks; bar n fills on tick n+1 of a step. */
  each('[data-letter]', function (root) {
    var late = root.querySelector('.late');
    var value = root.querySelector('.value');
    var reason = root.querySelector('.reason');
    var bars = all(root, '.bars i');
    var DAYS = [7, 21, 45];
    var TONES = ['a nudge', 'a reminder', 'firm'];
    steps.push(function () {
      var step = Math.floor(t / 6) % 3;
      var k = t % 6;
      late.textContent = DAYS[step] + 'd late';
      value.textContent = TONES[step];
      reason.textContent = 'Chosen because this invoice is ' + DAYS[step] + ' days past due.';
      bars.forEach(function (bar, i) { bar.classList.toggle('empty', k <= i); });
    });
  });

  /* Quote to cash: a 9-tick loop. Node n lights on tick n+1; the line follows. */
  each('[data-chain]', function (root) {
    var nodes = all(root, 'li');
    var fill = root.querySelector('.line i');
    steps.push(function () {
      var q = t % 9;
      nodes.forEach(function (node, i) { node.classList.toggle('lit', q > i); });
      fill.style.width = Math.max(0, Math.min(q, nodes.length) - 1) * 25 + '%';
    });
  });

  /* The decision: pressing the button dims the card and writes the audit line. It
     resets after 12 ticks; with reduced motion it stays. In the HTML the button is a
     picture of one (a span), like "send" and "edit": only here does it become a real
     button, so a page with no script shows no button that does nothing. It is never
     disabled, which would throw keyboard focus away: a second press just does nothing. */
  each('[data-decide]', function (root) {
    var drawn = root.querySelector('[data-go]');
    var go = document.createElement('button');
    var at = -1;
    go.type = 'button';
    go.className = drawn.className;
    go.textContent = drawn.textContent;
    drawn.parentNode.replaceChild(go, drawn);
    go.addEventListener('click', function () {
      if (at >= 0) return;
      at = t;
      root.classList.add('decided');
      go.setAttribute('aria-disabled', 'true');
    });
    steps.push(function () {
      if (at >= 0 && !reduced && t >= at + 12) {
        at = -1;
        root.classList.remove('decided');
        go.removeAttribute('aria-disabled');
      }
    });
  });

  /* A day with Xylum (who it's for): the lit step moves every 4 ticks. */
  each('[data-day]', function (root) {
    var items = all(root, 'li');
    steps.push(function () {
      var on = Math.floor(t / 4) % items.length;
      items.forEach(function (item, i) { item.classList.toggle('on', i === on); });
    });
  });

  /* Every app: hover, focus or a press picks an icon; its line shows underneath. */
  each('[data-picker]', function (root) {
    var buttons = all(root, '.icons button');
    var caps = all(root, '.caps li');
    function pick(index) {
      press(buttons, index);
      caps.forEach(function (cap, i) { cap.classList.toggle('on', i === index); });
    }
    buttons.forEach(function (button, i) {
      ['click', 'focus', 'mouseenter'].forEach(function (name) {
        button.addEventListener(name, function () { pick(i); });
      });
    });
  });

  if (!reduced && steps.length) {
    var run = function () { steps.forEach(function (step) { step(); }); };
    run();
    window.setInterval(function () {
      if (document.hidden) return;
      t += 1;
      run();
    }, TICK);
  }
})();
