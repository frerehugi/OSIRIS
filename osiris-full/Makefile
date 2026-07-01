# OSIRIS — Foundry Makefile
# Verwendung: make <target>

.PHONY: install build test coverage deploy-mocks deploy clean

# ─── Setup ───────────────────────────────────────────────────────────────────

install:
	forge install OpenZeppelin/openzeppelin-contracts --no-commit
	forge install foundry-rs/forge-std --no-commit
	npm install

# ─── Build ───────────────────────────────────────────────────────────────────

build:
	forge build

# ─── Tests ───────────────────────────────────────────────────────────────────

test:
	forge test -vvv

test-watch:
	forge test -vvv --watch

coverage:
	forge coverage --report summary

# ─── Deploy (Celo Sepolia) ───────────────────────────────────────────────────

deploy-mocks:
	forge script script/DeployMocks.s.sol \
		--rpc-url celo_sepolia \
		--broadcast \
		-vvvv

deploy:
	forge script script/Deploy.s.sol \
		--rpc-url celo_sepolia \
		--broadcast \
		--verify \
		-vvvv

# ─── Frontend ────────────────────────────────────────────────────────────────

dev:
	npm run dev

typecheck:
	npm run typecheck

# ─── Cleanup ─────────────────────────────────────────────────────────────────

clean:
	forge clean
	rm -rf node_modules dist
