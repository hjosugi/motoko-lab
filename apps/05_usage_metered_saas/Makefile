.PHONY: install check build test deploy-local

install:
	mops install

check:
	mops check

build:
	mops build

test:
	mops test

deploy-local:
	icp network start -d
	icp deploy
