/** @type {import("lint-staged").Configuration} */
export default {
  "*.{js,mjs,cjs,ts,mts,cts}": "eslint --fix --max-warnings=0",
  "*.{json,jsonc,yaml,yml,md}": "prettier --write",
};
