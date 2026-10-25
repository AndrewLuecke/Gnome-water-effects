UUID = water-effects@andrewluecke.github.io
SRC = src
BUILD = build
ZIP = $(BUILD)/$(UUID).shell-extension.zip

.PHONY: all pack install uninstall nested clean

all: $(SRC)/schemas/gschemas.compiled

$(SRC)/schemas/gschemas.compiled: $(SRC)/schemas/*.gschema.xml
	glib-compile-schemas --strict $(SRC)/schemas

pack: $(ZIP)

$(ZIP): $(SRC)/*.js $(SRC)/metadata.json $(SRC)/schemas/*.gschema.xml LICENSE
	mkdir -p $(BUILD)
	gnome-extensions pack --force --out-dir=$(BUILD) \
		--extra-source=waterEffect.js --extra-source=waterLayer.js \
		--extra-source=../LICENSE $(SRC)

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

# Runs a nested GNOME Shell in a window (needs the mutter-devkit package)
nested:
	dbus-run-session -- gnome-shell --devkit --wayland

clean:
	rm -rf $(BUILD) $(SRC)/schemas/gschemas.compiled
