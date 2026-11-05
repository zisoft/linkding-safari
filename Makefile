.PHONY: build run all

PROJECT_NAME=Linkding Safari
SCHEME=Linkding Safari (macOS)
EXTENSION_TARGET=Linkding Safari Extension (macOS)

all: build run
# all: build

build:
	xcodebuild -project "$(PROJECT_NAME).xcodeproj" \
		-scheme "$(SCHEME)" \
		-configuration Debug \
		CONFIGURATION_BUILD_DIR="$(PWD)/build" build

run:
	open "build/$(PROJECT_NAME).app"

clean:
	@xcodebuild -project "$(PROJECT_NAME).xcodeproj" \
		-scheme "$(PROJECT_NAME)" \
		-configuration Debug \
		clean
	@rm -rf build

