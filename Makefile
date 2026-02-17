SHELL := /bin/sh

.PHONY: dev deploy lint test build supabase-start

dev:
	npm install
	npm run dev

deploy:
	npm install
	npm run deploy

lint:
	npm run lint

test:
	npm run test

build:
	npm run build

supabase-start:
	supabase start
