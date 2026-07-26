# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the published package from `@oh-my-pi/swarm-extension` to `@san/swarm-extension`, its executable from `omp-swarm` to `san-swarm`, and its package manifest field from `omp` to `san`.

## [16.3.7] - 2026-07-05

### Fixed

- Fixed the peer dependency range for @oh-my-pi/pi-coding-agent to match the current ^16 major version.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
