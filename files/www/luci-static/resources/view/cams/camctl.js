'use strict';
'require form';
'require fs';
'require ui';
'require uci';

/* human-readable names of the usual UVC controls; unknown ones keep the driver name */
var LABELS = {
	brightness: 'Яскравість',
	contrast: 'Контрастність',
	saturation: 'Насиченість',
	hue: 'Відтінок',
	gamma: 'Гамма',
	gain: 'Підсилення',
	sharpness: 'Різкість',
	backlight_compensation: 'Компенсація контрового світла',
	white_balance_automatic: 'Автобаланс білого',
	white_balance_temperature_auto: 'Автобаланс білого',
	white_balance_temperature: 'Температура білого',
	power_line_frequency: 'Частота мережі (проти мерехтіння)',
	auto_exposure: 'Автоекспозиція',
	exposure_auto: 'Автоекспозиція',
	exposure_time_absolute: 'Витримка',
	exposure_absolute: 'Витримка',
	exposure_dynamic_framerate: 'Динамічна частота кадрів (у темряві камера знижує к/с)'
};

/* shown when the controls cannot be read from the camera */
var FALLBACK = [
	{ n: 'brightness', t: 'int' },
	{ n: 'contrast', t: 'int' },
	{ n: 'saturation', t: 'int' },
	{ n: 'sharpness', t: 'int' },
	{ n: 'gamma', t: 'int' },
	{ n: 'backlight_compensation', t: 'int' },
	{ n: 'white_balance_automatic', t: 'bool' },
	{ n: 'exposure_dynamic_framerate', t: 'bool' },
	{ n: 'power_line_frequency', t: 'menu', items: [ [ '0', 'вимкнено' ], [ '1', '50 Гц' ], [ '2', '60 Гц' ] ] }
];

function parseControls(text) {
	var out = [];
	String(text || '').split('\n').forEach(function(line) {
		var f = line.split('|');
		if (f.length < 8 || !f[0])
			return;
		var items = [];
		(f[8] || '').split(';').forEach(function(p) {
			var i = p.indexOf('=');
			if (i > 0)
				items.push([ p.substring(0, i), p.substring(i + 1) ]);
		});
		out.push({ n: f[0], t: f[1], min: f[2], max: f[3], step: f[4], def: f[5], cur: f[6], flags: f[7], items: items });
	});
	return out;
}

return L.view.extend({
	load: function() {
		return fs.exec('/usr/sbin/cams-camctl', [ 'sync' ]).catch(function() {}).then(function() {
			return Promise.all([
				L.resolveDefault(fs.exec_direct('/usr/sbin/cams-camctl', [ 'list' ]), ''),
				uci.load('cams')
			]);
		}).then(function(r) {
			var cams = [];
			String(r[0] || '').split('\n').forEach(function(line) {
				var f = line.split('|');
				if (f.length >= 6)
					cams.push({ bus: f[0], id: f[1], name: f[2], node: f[3], state: f[4], sec: f[5] });
			});
			return Promise.all(cams.map(function(c) {
				if (!c.node)
					return '';
				return L.resolveDefault(fs.exec_direct('/usr/sbin/cams-camctl', [ 'controls', c.node ]), '');
			})).then(function(ctl) {
				cams.forEach(function(c, i) { c.controls = parseControls(ctl[i]); });
				return cams;
			});
		});
	},

	render: function(cams) {
		var self = this;
		var m, s, o;

		m = new form.Map('cams', 'Вебкамери: параметри камер',
			'Глобальні параметри USB-камер (яскравість тощо). Збережені значення записуються в камеру щоразу, коли її підключають, ' +
			'Порожнє поле = не чіпати цей параметр. ' +
			'Параметри зображення на вкладці «Зображення» меню «Вебкамери» застосовуються пізніше, під час запуску потоку, і мають пріоритет.');

		if (!cams.length) {
			return m.render().then(function() {
				return E([
					E('h2', {}, 'Вебкамери: параметри камер'),
					E('div', { 'class': 'cbi-section' },
						E('p', {}, E('em', {}, 'USB-камер не виявлено. Підключіть камеру й оновіть сторінку.')))
				]);
			});
		}

		s = m.section(form.NamedSection, 'defaults', 'defaults', 'Загальне');
		s.addremove = false;

		o = s.option(form.Flag, 'camctl', 'Записувати параметри при підключенні камери');
		o.default = '1';
		o.rmempty = false;
		o.description = 'Також при завантаженні і при старті потоків. ' +
			'Кнопка «Записати в камери зараз» працює завжди.';

		cams.forEach(function(c) {
			var title = c.name + ' (' + c.id + ', шина ' + c.bus + ')';
			var ctl = c.controls;
			var exported = !c.node;

			s = m.section(form.NamedSection, c.sec, 'camctl', title);
			s.addremove = false;

			if (exported) {
				o = s.option(form.DummyValue, '_note_' + c.sec, 'Стан');
				o.cfgvalue = function() {
					return 'поточні значення недоступні (камера не готова), ' +
						'збережені параметри запишуться при наступному підключенні';
				};
			}

			(ctl.length ? ctl : FALLBACK).forEach(function(k) {
				var label = LABELS[k.n] || k.n;
				var opt;

				if (k.flags && k.flags.indexOf('read-only') >= 0)
					return;

				if (k.t === 'int') {
					opt = s.option(form.Value, k.n, label);
					opt.datatype = 'integer';
					opt.optional = true;
					if (k.min !== undefined && k.min !== '') {
						var lo = parseInt(k.min, 10), hi = parseInt(k.max, 10);
						opt.validate = function(sid, v) {
							if (v === '' || v == null)
								return true;
							var n = parseInt(v, 10);
							return (n >= lo && n <= hi) || ('Діапазон ' + lo + '...' + hi);
						};
						opt.description = 'діапазон ' + k.min + '...' + k.max + ', типово ' + k.def;
						opt.placeholder = 'зараз ' + k.cur;
					} else {
						opt.placeholder = 'без змін';
					}
				} else if (k.t === 'bool') {
					opt = s.option(form.ListValue, k.n, label);
					opt.value('', 'без змін' + (k.cur !== undefined && k.cur !== '' ? ' (зараз: ' + (k.cur === '1' ? 'увімк.' : 'вимк.') + ')' : ''));
					opt.value('1', 'увімкнено');
					opt.value('0', 'вимкнено');
					opt.optional = true;
				} else {
					opt = s.option(form.ListValue, k.n, label);
					opt.value('', 'без змін' + (k.cur ? ' (зараз: ' + k.cur + ')' : ''));
					(k.items || []).forEach(function(it) { opt.value(it[0], it[1]); });
					opt.optional = true;
				}
			});
		});

		return m.render().then(function(node) {
			var bar = E('div', { 'class': 'cbi-section' }, [
				E('button', {
					'class': 'cbi-button cbi-button-action',
					'click': ui.createHandlerFn(self, function() {
						return fs.exec('/usr/sbin/cams-camctl', [ 'apply', '--force' ]).then(function() {
							ui.addNotification(null, E('p', 'Збережені параметри записано в камери.'), 'info');
						}).catch(function(e) {
							ui.addNotification(null, E('p', 'Помилка: ' + e.message), 'danger');
						});
					})
				}, 'Записати в камери зараз'),
				E('span', { 'style': 'margin-left:1em' }, 'Спершу натисніть «Зберегти та застосувати», кнопка записує вже збережені значення.')
			]);
			return E([ bar, node ]);
		});
	}
});
