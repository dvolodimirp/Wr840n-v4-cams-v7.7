'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require uci';

/*
 * "Вебкамери: трафік": live statistics of every stream.
 * Data comes from /usr/sbin/cams-stats (see the format description there). Rates are computed here
 * from the difference between two snapshots, so nothing runs on the router while the page is closed.
 */

var HISTORY = 60;   /* samples kept for the sparkline */
var prev = {};      /* port -> previous sample */
var hist = {};      /* port -> [kbit/s, ...] */
var paused = false;
var interval = 2;
var pollFn = null;
var box = null;

function num(v) {
	if (v === '' || v == null) return null;
	var n = Number(v);
	return isNaN(n) ? null : n;
}

function fmt(v, d) {
	return v == null ? '—' : v.toFixed(d || 0);
}

function fmtBytes(b) {
	if (b == null) return '—';
	if (b >= 1048576) return (b / 1048576).toFixed(1) + ' МБ';
	if (b >= 1024) return (b / 1024).toFixed(0) + ' кБ';
	return b + ' Б';
}

function parse(text) {
	var t = null, cams = [];
	String(text || '').split('\n').forEach(function(line) {
		var f = line.split('|');
		if (f[0] === 'T' && f.length >= 6) {
			t = { up: num(f[1]), load: f[2], memAvail: num(f[3]), memTotal: num(f[4]), counters: f[5] === '1' };
		} else if (f[0] === 'C' && f.length >= 16) {
			cams.push({
				name: f[1], dev: f[2], port: f[3], engine: f[4], res: f[5], fpsReq: num(f[6]),
				bytes: num(f[7]), pkts: num(f[8]), conns: num(f[9]),
				online: f[10] === '' ? null : f[10] === '1',
				cap: num(f[11]), enc: num(f[12]), clients: num(f[13]),
				cfps: f[14] ? f[14].split(',').map(Number) : [],
				note: f[15]
			});
		}
	});
	return { t: t, cams: cams };
}

function sparkline(values, color) {
	var w = 160, h = 34, max = 1;
	values.forEach(function(v) { if (v > max) max = v; });
	var pts = values.map(function(v, i) {
		var x = values.length > 1 ? i * (w / (HISTORY - 1)) : 0;
		return x.toFixed(1) + ',' + (h - 2 - (h - 4) * v / max).toFixed(1);
	}).join(' ');
	var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('width', w);
	svg.setAttribute('height', h);
	svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
	svg.style.border = '1px solid var(--border-color-medium, #ccc)';
	svg.style.borderRadius = '3px';
	var pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
	pl.setAttribute('fill', 'none');
	pl.setAttribute('stroke', color || '#3a7bd5');
	pl.setAttribute('stroke-width', '1.5');
	pl.setAttribute('points', pts);
	svg.appendChild(pl);
	return svg;
}

function step(title, main, sub, warn) {
	return E('div', {
		'style': 'flex:1 1 150px;min-width:140px;padding:.5em .7em;margin:.2em;border:1px solid ' +
			(warn ? 'var(--warn-color-medium, #e6a100)' : 'var(--border-color-medium, #ccc)') +
			';border-radius:4px'
	}, [
		E('div', { 'style': 'font-size:85%;opacity:.7' }, title),
		E('div', { 'style': 'font-size:140%;font-weight:bold' }, main),
		E('div', { 'style': 'font-size:85%;min-height:1.2em' }, sub || '')
	]);
}

function camCard(c, rateKbit, kbPerFrame) {
	var isUs = c.engine === 'ustreamer';
	var hints = [];
	var capWarn = false, encWarn = false;

	if (isUs && c.online === false)
		hints.push('Камера не віддає кадри (online=false).');
	if (isUs && c.cap != null && c.fpsReq != null && c.cap < c.fpsReq * 0.8) {
		capWarn = true;
		hints.push('Камера/USB віддає менше кадрів, ніж запитано (' + c.cap + ' з ' + c.fpsReq + ').');
	}
	if (isUs && c.cap != null && c.enc != null && c.clients > 0 && c.enc < c.cap * 0.8) {
		encWarn = true;
		hints.push('Кадри губляться після камери: кодування JPEG, ймовірно, не встигає (' + c.enc + ' з ' + c.cap + ').');
	}
	if (isUs && c.enc != null && c.clients > 0 && c.cfps.length) {
		var slow = c.cfps.some(function(v) { return v < c.enc * 0.8; });
		if (slow)
			hints.push('Хтось із глядачів отримує менше кадрів, ніж виходить з кодера: вузьке місце — мережа або сам клієнт.');
	}
	if (!isUs)
		hints.push('mjpg-streamer не віддає статистику по кроках: тут лише мережа й підключення. ' +
			'Кадри по кроках: MJPG_STATS=1 при ручному запуску, рядки «stats» у logread.');
	if (c.note === 'rotfallback')
		hints.push('Поворот 180°: ця камера працює через mjpg-streamer.');

	var cfpsText = c.cfps.length ? c.cfps.join(' / ') + ' к/с' : '';

	return E('div', { 'class': 'cbi-section', 'style': 'margin-bottom:1em' }, [
		E('h3', {}, [ c.name, E('small', { 'style': 'font-weight:normal;margin-left:.6em;opacity:.7' },
			c.dev + ' · порт ' + c.port + ' · ' + 'mjpg-streamer' + ' · ' + c.res +
			' · запит ' + fmt(c.fpsReq) + ' к/с') ]),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;align-items:stretch' }, [
			step('1. Камера', isUs ? fmt(c.cap) + ' к/с' : '—',
				isUs ? (c.online === false ? 'немає сигналу' : c.online ? 'онлайн' : '') : '', capWarn),
			step('2. Кодер JPEG', isUs ? fmt(c.enc) + ' к/с' : '—', isUs ? 'вихід у чергу HTTP' : '', encWarn),
			step('3. Глядачі', isUs ? fmt(c.clients) : fmt(c.conns),
				isUs ? cfpsText : 'підключень (без 127.0.0.1)'),
			step('4. Мережа ↑', rateKbit == null ? '—' : fmt(rateKbit) + ' кбіт/с',
				kbPerFrame == null ? '' : '≈ ' + fmt(kbPerFrame, 1) + ' кБ на кадр')
		]),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;align-items:center;margin:.4em .2em' }, [
			sparkline(hist[c.port] || [], '#3a7bd5'),
			E('span', { 'style': 'margin-left:.8em;font-size:90%' },
				'Усього відправлено: ' + fmtBytes(c.bytes) + (c.pkts != null ? ' (' + c.pkts + ' пакетів)' : '') +
				' · TCP-підключень: ' + fmt(c.conns))
		]),
		hints.length ? E('ul', { 'style': 'margin:.3em 1.2em' }, hints.map(function(h) { return E('li', {}, h); })) : ''
	]);
}

function update() {
	if (paused)
		return Promise.resolve();

	return L.resolveDefault(fs.exec_direct('/usr/sbin/cams-stats'), '').then(function(out) {
		var d = parse(out);
		var cards = [];

		d.cams.forEach(function(c) {
			var rate = null, kbf = null, p = prev[c.port];
			if (p && d.t && p.up != null && c.bytes != null && p.bytes != null && d.t.up > p.up && c.bytes >= p.bytes) {
				var bps = (c.bytes - p.bytes) / (d.t.up - p.up);
				rate = bps * 8 / 1000;
				var fr = c.cfps.reduce(function(a, b) { return a + b; }, 0);
				if (fr > 0 && bps > 0)
					kbf = bps / fr / 1024;
			}
			if (d.t && c.bytes != null)
				prev[c.port] = { up: d.t.up, bytes: c.bytes };
			var hh = hist[c.port] = hist[c.port] || [];
			hh.push(rate == null ? 0 : rate);
			if (hh.length > HISTORY) hh.shift();
			cards.push(camCard(c, rate, kbf));
		});

		var head = [];
		if (d.t) {
			var used = d.t.memTotal && d.t.memAvail != null ? Math.round(100 * (1 - d.t.memAvail / d.t.memTotal)) : null;
			head.push(E('p', {}, 'Навантаження роутера (load, 1 хв): ' + d.t.load +
				(used != null ? ' · пам\'ять зайнята: ' + used + '%' : '') +
				(d.t.counters ? '' : ' · лічильників байтів немає (потрібен nft; перевірте, що меню увімкнено в налаштуваннях)')));
		}

		dom.content(box, head.concat(cards.length ? cards :
			[ E('p', {}, E('em', {}, 'Камер не знайдено або всі вимкнені.')) ]));
	});
}

function restartPoll() {
	if (pollFn) poll.remove(pollFn);
	pollFn = update;
	poll.add(pollFn, interval);
}

return L.view.extend({
	load: function() {
		return uci.load('cams');
	},

	render: function() {
		if (uci.get('cams', 'defaults', 'info') !== '1') {
			return E([
				E('h2', {}, 'Вебкамери: трафік і потік'),
				E('p', {}, 'Статистика вимкнена. Увімкніть «Меню трафіку» в розділі «Загальне» на сторінці '),
				E('p', {}, E('a', { href: L.url('admin', 'services', 'cams') }, 'Вебкамери'))
			]);
		}
		box = E('div', {});

		var sel = E('select', {
			'class': 'cbi-input-select',
			'change': function(ev) { interval = Number(ev.target.value); restartPoll(); }
		}, [ 1, 2, 5, 10 ].map(function(v) {
			return E('option', { value: v, selected: v === interval }, v + ' с');
		}));

		var pauseBtn = E('button', {
			'class': 'cbi-button',
			'click': function(ev) {
				paused = !paused;
				ev.target.textContent = paused ? 'Продовжити' : 'Пауза';
			}
		}, 'Пауза');

		var resetBtn = E('button', {
			'class': 'cbi-button',
			'style': 'margin-left:.5em',
			'click': function() { prev = {}; hist = {}; return update(); }
		}, 'Скинути графіки');

		var root = E([
			E('h2', {}, 'Вебкамери: трафік і потік'),
			E('p', { 'class': 'cbi-section-descr' },
				'Живі дані по кроках: камера → кодер JPEG → глядачі → мережа. ' +
				'Сторінка опитує роутер лише поки відкрита. Трафік — це вихідні байти від роутера до глядачів ' +
				'(разом із заголовками IP/TCP).'),
			E('div', { 'style': 'margin-bottom:.8em' }, [
				E('span', {}, 'Оновлення: '), sel, ' ', pauseBtn, resetBtn
			]),
			box
		]);

		restartPoll();
		update();
		return root;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
