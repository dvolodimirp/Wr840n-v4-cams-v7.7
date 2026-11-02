'use strict';
'require view';
'require fs';
'require poll';
'require ui';

var CLASSES = {
	'00': 'на рівні інтерфейсів', '01': 'Audio', '02': 'CDC', '03': 'HID', '08': 'Storage',
	'09': 'Hub', '0e': 'Video (UVC)', '0a': 'CDC data', 'e0': 'Wireless', 'ef': 'Composite', 'ff': 'Vendor'
};
var ERR = {
	'-71': 'EPROTO: помилка протоколу (кабель, живлення, наводки)',
	'-110': 'ETIMEDOUT: пристрій не відповів',
	'-32': 'EPIPE: помилка/stall каналу',
	'-19': 'ENODEV: пристрій зник',
	'-84': 'EILSEQ: збій CRC/бітстаффінгу',
	'-62': 'ETIME: таймаут',
	'-108': 'ESHUTDOWN: контролер/пристрій вимкнено',
	'-75': 'EOVERFLOW: переповнення (babble)',
	'-2': 'ENOENT: URB скасовано/не знайдено (норма при зупинці потоку)',
	'-1': 'EPERM: URB скасовано (норма при зупинці або перезапуску потоку камери)'
};
var TYPES = {
	connect: 'підключення', disconnect: 'відключення', reset: 'скидання (reset)',
	power: 'живлення порту', error: 'помилка USB', uvc: 'помилка UVC'
};
var BADGE = { ERROR: '#c0392b', WARN: '#d68910', INFO: '#2e7d32' };

function exec(args) {
	return L.resolveDefault(fs.exec_direct('/usr/sbin/usbdiag', args), '');
}

function parseTree(text) {
	var r = { uptime: 0, dev: {}, order: [], ports: {}, kids: {} };
	String(text || '').split('\n').forEach(function(line) {
		var f = line.split('|');
		if (f[0] === 'U') {
			r.uptime = parseFloat(f[1]) || 0;
		} else if (f[0] === 'D' && f.length >= 15) {
			var d = {
				bus: f[1], parent: f[2], port: f[3], id: f[4], vendor: f[5], product: f[6], devnum: f[7],
				speed: f[8], driver: f[9], cls: f[10], maxchild: parseInt(f[11], 10) || 0,
				ifs: f[12] ? f[12].split(',') : [], runtime: f[13], auth: f[14], ctrl: f[15] || ''
			};
			r.dev[d.bus] = d;
			r.order.push(d.bus);
			(r.kids[d.parent] = r.kids[d.parent] || []).push(d.bus);
		} else if (f[0] === 'P' && f.length >= 5) {
			(r.ports[f[1]] = r.ports[f[1]] || []).push({ port: parseInt(f[2], 10), child: f[3], present: f[4] === '1' });
		}
	});
	return r;
}

function parseEvents(text, tree) {
	var up = 0, ev = [];
	String(text || '').split('\n').forEach(function(line) {
		var f = line.split('|');
		if (f[0] === 'U') {
			up = parseFloat(f[1]) || 0;
		} else if (f[0] === 'E' && f.length >= 6) {
			ev.push({ ts: parseFloat(f[1]) || 0, bus: f[2], type: f[3], code: f[4], msg: f.slice(5).join('|') });
		}
	});
	ev.forEach(function(e) {
		var d = tree.dev[e.bus];
		e.hub = !!(d && d.maxchild > 0) || /^usb/.test(e.bus);
		e.hubBus = e.hub;
		if (e.type === 'uvc' && (e.code === '-1' || e.code === '-2'))
			e.level = 'WARN';
		else if (e.type === 'error' || e.type === 'uvc')
			e.level = 'ERROR';
		else if (e.type === 'disconnect')
			e.level = (d && d.maxchild > 0) || (!d && tree.kids[e.bus]) ? 'ERROR' : 'WARN';
		else if (e.type === 'reset' || e.type === 'power')
			e.level = 'WARN';
		else
			e.level = 'INFO';
	});
	return { uptime: up, list: ev };
}

function badge(text, level) {
	return E('span', {
		'style': 'display:inline-block;padding:0 .5em;border-radius:3px;color:#fff;font-size:85%;background:' + (BADGE[level] || '#555')
	}, text);
}

function fmtUp(sec) {
	sec = Math.max(0, Math.round(sec));
	var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), x = sec % 60;
	return (d ? d + ' д ' : '') + (d || h ? h + ' год ' : '') + (d || h || m ? m + ' хв ' : '') + x + ' с';
}

function fmtSince(sec) {
	sec = Math.max(0, Math.round(sec));
	if (sec < 90) return sec + ' с тому';
	if (sec < 5400) return Math.round(sec / 60) + ' хв тому';
	if (sec < 172800) return Math.round(sec / 3600) + ' год тому';
	return Math.floor(sec / 86400) + ' д ' + Math.round(sec % 86400 / 3600) + ' год тому';
}

/* identical consecutive events (the driver prints one line per URB in flight) become one row with a counter */
function groupEvents(list) {
	var out = [];
	list.forEach(function(e) {
		var last = out[out.length - 1];
		var key = e.bus + '|' + e.type + '|' + e.code + '|' + e.msg;
		if (last && last.key === key && e.ts - last.ts < 10) {
			last.n++;
			last.ts = e.ts;
		} else {
			out.push({ key: key, n: 1, ts: e.ts, first: e.ts, bus: e.bus, type: e.type, code: e.code, msg: e.msg, level: e.level });
		}
	});
	return out;
}

function ifaceText(d) {
	var seen = {};
	var out = [];
	d.ifs.forEach(function(s) {
		var a = s.split('/');
		var k = (CLASSES[a[0]] || a[0]) + (a[1] ? ' · ' + a[1] : ' · без драйвера');
		if (!seen[k]) { seen[k] = 1; out.push(k); }
	});
	return out.join(', ');
}

function lastEvent(ev, bus) {
	for (var i = ev.list.length - 1; i >= 0; i--)
		if (ev.list[i].bus === bus) return ev.list[i];
	return null;
}

function portState(pt, tree, ev) {
	var le = lastEvent(ev, pt.child);
	var ago = le ? ev.uptime - le.ts : 1e9;
	if (pt.present) {
		if (le && ago < 10 && (le.type === 'reset' || le.type === 'connect'))
			return [ 'повторна ініціалізація', 'WARN' ];
		return [ 'підключено', 'INFO' ];
	}
	if (le && le.type === 'disconnect' && ago < 600)
		return [ 'відключено (' + fmtSince(ago) + ')', 'WARN' ];
	return [ 'порожній', null ];
}

function devLine(d, ev) {
	var parts = [ d.id, d.speed ? d.speed + ' Mbps' : '', ifaceText(d) ];
	if (d.driver && d.maxchild === 0 && !d.ifs.length) parts.push('драйвер ' + d.driver);
	return E('div', {}, [
		E('strong', {}, (d.product || d.id) + (d.vendor && d.product.indexOf(d.vendor) < 0 ? ' (' + d.vendor + ')' : '')),
		E('div', { 'style': 'opacity:.8;font-size:90%' },
			parts.filter(Boolean).join(' · ') + ' · BUSID ' + d.bus + ' · DEVNUM ' + d.devnum +
			(d.runtime ? ' · живлення: ' + d.runtime : '') + (d.auth === '0' ? ' · не авторизовано' : ''))
	]);
}

function renderHub(bus, tree, ev, depth) {
	var d = tree.dev[bus];
	var nodes = [];
	var pad = 'margin-left:' + (depth * 1.5) + 'em;';
	var title = depth === 0
		? 'USB Controller: ' + (d.ctrl || d.product) + ' (usb' + bus.replace('usb', '') + ', ' + (d.speed || '?') + ' Mbps)'
		: 'Hub ' + bus + ': ' + (d.product || d.id) + ' (' + (d.speed || '?') + ' Mbps, портів ' + d.maxchild + ')';
	nodes.push(E('div', { 'style': pad + 'margin-top:.6em;font-weight:bold' }, title));
	(tree.ports[bus] || []).forEach(function(pt) {
		var st = portState(pt, tree, ev);
		var child = tree.dev[pt.child];
		var row = [
			E('div', { 'style': 'min-width:15em' }, [
				'Port ' + pt.port + ' ',
				st[1] ? badge(st[0], st[1]) : E('span', { 'style': 'opacity:.6' }, st[0])
			])
		];
		if (child) row.push(devLine(child, ev));
		nodes.push(E('div', { 'style': pad + 'margin-left:' + (depth * 1.5 + 1.5) + 'em;display:flex;gap:1em;padding:.2em 0' }, row));
		if (child && child.maxchild > 0)
			renderHub(pt.child, tree, ev, depth + 1).forEach(function(n) { nodes.push(n); });
	});
	return nodes;
}

function flapWarnings(ev) {
	var cnt = {}, out = [];
	ev.list.forEach(function(e) {
		if (e.type === 'disconnect' && ev.uptime - e.ts < 120)
			cnt[e.bus] = (cnt[e.bus] || 0) + 1;
	});
	Object.keys(cnt).forEach(function(b) {
		if (cnt[b] >= 3)
			out.push('Нестабільне з\'єднання: ' + b + ' відключався ' + cnt[b] + ' раз(и) за останні 2 хв.');
	});
	return out;
}

function reportText(tree, ev) {
	var lines = [ 'USB дерево:' ];
	tree.order.forEach(function(b) {
		var d = tree.dev[b];
		lines.push('  ' + b + ' ' + d.id + ' ' + d.product + ' ' + d.speed + 'M drv=' + d.driver + ' if=' + ifaceText(d));
	});
	lines.push('', 'Події:');
	groupEvents(ev.list).forEach(function(e) {
		lines.push('  [' + e.ts.toFixed(1) + '] ' + e.level + ' ' + (e.bus || '-') + ' ' + e.type + ' ' + e.code + (e.n > 1 ? ' x' + e.n : '') + ' | ' + e.msg);
	});
	return lines.join('\n');
}

return view.extend({
	load: function() {
		return Promise.all([ exec([ 'tree' ]), exec([ 'events', '600' ]) ]);
	},

	render: function(data) {
		var self = this;
		var state = { interval: 3, paused: false, filter: 'all', tree: null, ev: null };
		var treeBox = E('div', { 'class': 'cbi-section' });
		var warnBox = E('div');
		var evBox = E('div', { 'class': 'cbi-section' });
		var repBox = E('div');
		var stamp = E('span', { 'style': 'opacity:.7;margin-left:1em' });

		function draw(rawTree, rawEv) {
			var tree = parseTree(rawTree);
			var ev = parseEvents(rawEv, tree);
			state.tree = tree; state.ev = ev;

			var roots = tree.order.filter(function(b) { return !tree.dev[b].parent; });
			var nodes = [];
			if (!roots.length)
				nodes.push(E('p', {}, E('em', {}, 'USB-контролерів не знайдено (чи є USB у DTS і kmod-usb2/ohci?).')));
			roots.forEach(function(r) {
				renderHub(r, tree, ev, 0).forEach(function(n) { nodes.push(n); });
			});
			treeBox.innerHTML = '';
			treeBox.appendChild(E('h3', {}, 'Дерево USB'));
			nodes.forEach(function(n) { treeBox.appendChild(n); });

			warnBox.innerHTML = '';
			flapWarnings(ev).forEach(function(w) {
				warnBox.appendChild(E('div', { 'class': 'alert-message warning' }, w));
			});

			var list = groupEvents(ev.list).reverse().filter(function(e) {
				return state.filter === 'all' || e.level !== 'INFO';
			});
			var rows = list.slice(0, 200).map(function(e) {
				var d = tree.dev[e.bus];
				var tip = ERR[e.code] || '';
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'title': 'від початку роботи: ' + fmtUp(e.ts) + (e.n > 1 ? ' (перша подія в групі: ' + fmtUp(e.first) + ')' : '') },
						new Date(Date.now() - (ev.uptime - e.ts) * 1000).toLocaleTimeString() + ' (' + fmtSince(ev.uptime - e.ts) + ')'),
					E('td', { 'class': 'td' }, badge(e.level, e.level)),
					E('td', { 'class': 'td' }, e.bus || '—'),
					E('td', { 'class': 'td' }, d ? (d.product || d.id) : '—'),
					E('td', { 'class': 'td' }, (TYPES[e.type] || e.type) + (e.code ? ' ' + e.code : '') + (e.n > 1 ? '  ×' + e.n : '')),
					E('td', { 'class': 'td', 'title': tip }, e.msg + (tip ? '  [' + tip + ']' : ''))
				]);
			});
			evBox.innerHTML = '';
			evBox.appendChild(E('h3', {}, 'Журнал і історія USB-подій'));
			evBox.appendChild(rows.length ? E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [ 'Час', 'Рівень', 'Порт/шина', 'Пристрій', 'Подія', 'Повідомлення ядра' ].map(function(t) {
					return E('th', { 'class': 'th' }, t);
				}))
			].concat(rows)) : E('p', {}, E('em', {}, 'Подій немає (буфер ядра чистий або фільтр порожній).')));
			stamp.textContent = 'оновлено ' + new Date().toLocaleTimeString();
		}

		function refresh() {
			if (state.paused) return Promise.resolve();
			return Promise.all([ exec([ 'tree' ]), exec([ 'events', '600' ]) ]).then(function(r) { draw(r[0], r[1]); });
		}

		function restartPoll() {
			poll.remove(refresh);
			poll.add(refresh, state.interval);
			poll.start();
		}

		var sel = E('select', { 'class': 'cbi-input-select', 'change': function(ev) {
			state.interval = parseInt(ev.target.value, 10);
			restartPoll();
		} }, [ 2, 3, 5 ].map(function(n) {
			return E('option', { value: n, selected: n === state.interval ? 'selected' : null }, n + ' с');
		}));

		var flt = E('select', { 'class': 'cbi-input-select', 'change': function(ev) {
			state.filter = ev.target.value;
			draw(data[0], data[1]);
			refresh();
		} }, [ E('option', { value: 'all' }, 'усі події'), E('option', { value: 'bad' }, 'лише помилки й попередження') ]);

		var bar = E('div', { 'class': 'cbi-section' }, [
			E('label', {}, [ 'Оновлення: ', sel ]), ' ',
			E('label', { 'style': 'margin-left:1em' }, [
				E('input', { 'type': 'checkbox', 'change': function(ev) { state.paused = ev.target.checked; } }), ' пауза'
			]),
			E('label', { 'style': 'margin-left:1em' }, [ 'Фільтр: ', flt ]),
			E('button', { 'class': 'cbi-button', 'style': 'margin-left:1em', 'click': function() {
				repBox.innerHTML = '';
				var ta = E('textarea', { 'readonly': 'readonly', 'style': 'width:100%;height:16em;font-family:monospace' },
					reportText(state.tree, state.ev));
				repBox.appendChild(ta);
				ta.select();
			} }, 'Звіт для копіювання'),
			stamp
		]);

		draw(data[0], data[1]);
		restartPoll();

		return E([
			E('h2', {}, 'USB Diagnostics'),
			E('div', { 'class': 'cbi-map-descr' },
				'Лише читання: sysfs (дерево) і буфер повідомлень ядра dmesg (події). Фонового демона нема. ' +
				'Буфер ядра кільцевий, тож дуже давні події з нього зникають; сторінка показує все, що в ньому лишилось.'),
			bar, repBox, warnBox, treeBox, evBox
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
