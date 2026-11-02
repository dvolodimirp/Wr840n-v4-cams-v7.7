'use strict';
'require form';
'require fs';
'require ui';
'require uci';

function okCred(section_id, value) {
	if (value === '' || value == null)
		return true;
	return /^[A-Za-z0-9._~-]{1,32}$/.test(value) ||
		'Дозволені літери, цифри та . _ ~ - (до 32 символів)';
}

return L.view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(fs.exec_direct('/usr/sbin/cams-list'), ''),
			uci.load('cams'),
			L.resolveDefault(fs.exec_direct('/usr/sbin/cams-svc', [ 'status' ]), '')
		]);
	},

	render: function(data) {
		var listing = data[0];
		var svc = {};
		String(data[2] || '').trim().split(/\s+/).forEach(function(kv) {
			var a = kv.split('=');
			if (a.length === 2) svc[a[0]] = a[1];
		});
		var self = this;
		var m, s, o, rows = [];

		String(listing || '').split('\n').forEach(function(line) {
			var f = line.split('|');
			if (f.length < 15)
				return;
			var path = '/?action=stream';
			var url = location.protocol + '//' + location.hostname + ':' + f[2] + path;
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, f[13]),
				E('td', { 'class': 'td' }, f[0]),
				E('td', { 'class': 'td' }, E('a', { href: url, target: '_blank' }, url)),
				E('td', { 'class': 'td' }, f[3] ? 'так' : 'ні')
			]));
		});

		function runInit(action, okText, reloadMs) {
			return fs.exec('/usr/sbin/cams-svc', [ action ]).then(function() {
				ui.addNotification(null, E('p', okText), 'info');
				if (reloadMs)
					window.setTimeout(function() { location.reload(); }, reloadMs);
			}).catch(function(e) {
				ui.addNotification(null, E('p', 'Помилка: ' + e.message), 'danger');
			});
		}

		function btn(label, cls, fn) {
			return E('button', {
				'class': 'cbi-button ' + cls,
				'style': 'margin-right:.5em',
				'click': ui.createHandlerFn(self, fn)
			}, label);
		}

		var svcRows = [
			[ 'Сервіс потоків', svc.autostart === '1' ? 'активний (автозапуск увімкнено)' : 'неактивний (автозапуск вимкнено)' ],
			[ 'Потоки зараз', svc.running === '1' ? 'працюють' : (svc.stopped === '1' ? 'зупинені вручну' : 'не працюють') ],
			[ 'Рушій', svc.mjpg === '1' ? 'mjpg-streamer' : 'немає в образі' ]
		];

		var info = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, 'Сервіс потоків (mjpg-streamer)'),
			E('table', { 'class': 'table' }, svcRows.map(function(r) {
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'style': 'width:14em' }, r[0]),
					E('td', { 'class': 'td left' }, r[1])
				]);
			})),
			E('div', { 'style': 'margin:.8em 0' }, [
				svc.autostart === '1'
					? btn('Деактивувати сервіс', 'cbi-button-negative', function() {
						return runInit('deactivate', 'Автозапуск вимкнено, потоки зупиняються.', 4000);
					})
					: btn('Активувати сервіс', 'cbi-button-positive', function() {
						return runInit('activate', 'Автозапуск увімкнено, потоки запускаються.', 8000);
					}),
				btn('Запустити', 'cbi-button-positive', function() {
					return runInit('start', 'Потоки запускаються. Сторінка оновиться сама.', 8000);
				}),
				btn('Зупинити', 'cbi-button-negative', function() {
					return runInit('stop', 'Потоки зупинено (watchdog їх не чіпає, доки не натиснете «Запустити»).', 3000);
				}),
				btn('Перезапустити', 'cbi-button-action', function() {
					return runInit('restart', 'Потоки перезапускаються. Сторінка оновиться сама.', 8000);
				}),
				btn('Застосувати яскравість тощо', 'cbi-button', function() {
					return fs.exec('/usr/sbin/cams-apply', []).then(function() {
						ui.addNotification(null, E('p', 'Параметри зображення застосовано.'), 'info');
					});
				})
			]),
			E('p', { 'class': 'cbi-value-description' },
				'«Активувати» вмикає автозапуск при завантаженні, watchdog і запускає потоки; «Деактивувати» вимикає автозапуск і зупиняє потоки. ' +
				'Watchdog працює лише коли сервіс активний і не зупинений вручну.'),
			E('h3', {}, 'Активні потоки'),
			rows.length ? E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, 'Камера'),
					E('th', { 'class': 'th' }, 'Пристрій'),
					E('th', { 'class': 'th' }, 'Адреса потоку'),
					E('th', { 'class': 'th' }, 'Пароль')
				])
			].concat(rows)) : E('p', {}, E('em', {}, 'Камер не знайдено або всі вимкнені.'))
		]);

		m = new form.Map('cams', 'Вебкамери',
			'Налаштування USB-камер. Нові камери з\'являються тут автоматично після підключення. ' +
			'Зміна роздільності, частоти, порту, повороту чи пароля перезапускає потоки (кілька секунд без картинки); ' +
			'зміна яскравості, контрасту тощо застосовується на ходу.');

		/* ---------- general ---------- */
		s = m.section(form.NamedSection, 'defaults', 'defaults', 'Загальне');
		s.addremove = false;

		o = s.option(form.DummyValue, '_other_pages', 'Інші сторінки');
		o.rawhtml = true;
		o.cfgvalue = function() {
			return '<a href="' + L.url('admin', 'services', 'cams-camctl') + '">параметри камер (яскравість тощо, записуються при підключенні)</a>';
		};

		/* ---------- cameras ---------- */
		s = m.section(form.TypedSection, 'camera', 'Камери');
		s.anonymous = true;
		s.addremove = false;
		s.tab('stream', 'Потік');
		s.tab('image', 'Зображення');

		/* --- tab: stream --- */
		o = s.taboption('stream', form.DummyValue, 'name', 'Камера');

		o = s.taboption('stream', form.Flag, 'enabled', 'Увімкнено');
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('stream', form.ListValue, 'res', 'Роздільність');
		[ '160x120', '176x144', '320x240', '352x288', '640x480' ].forEach(function(v) { o.value(v); });
		o.default = '320x240';
		o.description = 'Камери без MJPEG стискаються процесором роутера: 640x480 доступно лише з дуже низькою частотою.';

		o = s.taboption('stream', form.ListValue, 'fps', 'Частота кадрів');
		[ '5', '10', '15', '20', '25', '30' ].forEach(function(v) { o.value(v); });
		o.default = '10';
		o.description = 'Береться з частот, які підтримує камера (зазвичай 5, 10, 15, 20...). 10 к/с для двох камер на 320x240 прийнятно; вище навантажує процесор.';

		o = s.taboption('stream', form.ListValue, 'rotate', 'Поворот зображення');
		o.value('0', 'без повороту');
		o.value('180', '180°');
		o.default = '0';
		o.description = 'Програмний поворот у mjpg-streamer (патч 060, без додаткового проходу по кадру). Застосовується з перезапуском потоку.';

		o = s.taboption('stream', form.Value, 'port', 'Порт');
		o.datatype = 'port';
		o.placeholder = 'авто (8080, 8081, ...)';
		o.optional = true;

		o = s.taboption('stream', form.Value, 'user', 'Логін потоку');
		o.optional = true;
		o.validate = okCred;
		o.description = 'Порожньо = без пароля. Пароль передається без шифрування (HTTP Basic), зберігається у відкритому вигляді в /etc/config/cams.';

		o = s.taboption('stream', form.Value, 'pass', 'Пароль потоку');
		o.optional = true;
		o.password = true;
		o.validate = okCred;

		/* --- tab: image --- */
		o = s.taboption('image', form.Value, 'brightness', 'Яскравість');
		o.datatype = 'integer';
		o.optional = true;
		o.placeholder = 'без змін';
		o.description = 'Діапазон залежить від камери (HP Webcam: -64...127).';

		o = s.taboption('image', form.Value, 'contrast', 'Контрастність');
		o.datatype = 'integer';
		o.optional = true;
		o.placeholder = 'без змін';

		o = s.taboption('image', form.Value, 'saturation', 'Насиченість');
		o.datatype = 'integer';
		o.optional = true;
		o.placeholder = 'без змін';

		o = s.taboption('image', form.Value, 'gamma', 'Гамма');
		o.datatype = 'integer';
		o.optional = true;
		o.placeholder = 'без змін';

		o = s.taboption('image', form.Value, 'sharpness', 'Різкість');
		o.datatype = 'integer';
		o.optional = true;
		o.placeholder = 'без змін';

		o = s.taboption('image', form.ListValue, 'powerline', 'Частота мережі (проти мерехтіння)');
		o.value('', 'без змін');
		o.value('0', 'вимкнено');
		o.value('1', '50 Гц');
		o.value('2', '60 Гц');
		o.optional = true;

		return m.render().then(function(node) {
			return E([ info, node ]);
		});
	}
});
