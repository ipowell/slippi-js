import { SlippiGame } from "../src";

const game = new SlippiGame("/mnt/hdd/Development/slippi-js/test/test.slp");

const combos = game.getStats()?.combos;
console.log(combos);
