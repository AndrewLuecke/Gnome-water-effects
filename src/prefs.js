import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class WaterEffectsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const effects = [
            ['ripples', _('Ripples')],
            ['waves', _('Waves')],
        ];

        const effectGroup = new Adw.PreferencesGroup({
            title: _('Effect'),
            description: _('Ripples reflect the desktop in the water. Waves add a swell that rolls across the screen.'),
        });
        page.add(effectGroup);

        const effectRow = new Adw.ComboRow({
            title: _('Effect'),
            model: Gtk.StringList.new(effects.map(([, label]) => label)),
            selected: Math.max(0,
                effects.findIndex(([id]) => id === settings.get_string('effect'))),
        });
        effectRow.connect('notify::selected',
            () => settings.set_string('effect', effects[effectRow.selected][0]));
        effectGroup.add(effectRow);

        const waterGroup = new Adw.PreferencesGroup({title: _('Water')});
        page.add(waterGroup);

        waterGroup.add(this._spinRow(settings, 'water-height', {
            title: _('Depth'),
            subtitle: _('Height of the water in pixels'),
            step: 8,
        }));
        waterGroup.add(this._spinRow(settings, 'amplitude', {
            title: _('Strength'),
            subtitle: _('1 matches Enlightenment 16'),
            step: 0.1,
            digits: 1,
        }));
        waterGroup.add(this._spinRow(settings, 'speed', {
            title: _('Speed'),
            subtitle: _('1 matches Enlightenment 16'),
            step: 0.1,
            digits: 1,
        }));

        const panelsRow = new Adw.SwitchRow({
            title: _('Stay Above Panels'),
            subtitle: _('Keep the water above panels and docks at the bottom of the screen'),
        });
        settings.bind('above-panels', panelsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        waterGroup.add(panelsRow);

        const performanceGroup = new Adw.PreferencesGroup({
            title: _('Performance'),
            description: _('The water stops moving while a window covers it or a window is fullscreen.'),
        });
        page.add(performanceGroup);

        performanceGroup.add(this._spinRow(settings, 'frame-rate', {
            title: _('Frame Rate'),
            subtitle: _('Lower rates use less power'),
            step: 5,
        }));
    }

    // A spin row bound to a settings key, limited to the key's range in the
    // schema. get_range() gives ('range', (min, max)).
    _spinRow(settings, key, {title, subtitle, step, digits = 0}) {
        const [, [min, max]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        const row = new Adw.SpinRow({
            title,
            subtitle,
            digits,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
