import { EventEmitter } from "events";
import { last } from "lodash";

import type { FrameEntryType, FramesType, GameStartType, PostFrameUpdateType } from "../types";
import type { ComboType, MoveLandedType, PlayerIndicesType } from "./common";
import { getPlayerPermutationsFromSettings } from "./common";
import {
  calcDamageTaken,
  didLoseStock,
  isCommandGrabbed,
  isDamaged,
  isDead,
  isDown,
  isGrabbed,
  isTeching,
  Timers,
} from "./common";
import type { StatComputer } from "./stats";

export enum ComboEvent {
  COMBO_START = "COMBO_START",
  COMBO_EXTEND = "COMBO_EXTEND",
  COMBO_END = "COMBO_END",
}

interface ComboState {
  combo: ComboType | null;
  move: MoveLandedType | null;
  resetCounter: number;
  lastHitAnimation: number | null;
  event: ComboEvent | null;
}

export class ComboComputer extends EventEmitter implements StatComputer<ComboType[]> {
  private playerPermutations = new Array<PlayerIndicesType>();
  private state = new Map<PlayerIndicesType, ComboState>();
  private combos = new Array<ComboType>();
  private settings: GameStartType | null = null;

  public setup(settings: GameStartType): void {
    // Reset the state
    this.settings = settings;
    this.state = new Map();
    this.combos = [];
    this.playerPermutations = getPlayerPermutationsFromSettings(settings);

    this.playerPermutations.forEach((indices) => {
      const playerState: ComboState = {
        combo: null,
        move: null,
        resetCounter: 0,
        lastHitAnimation: null,
        event: null,
      };
      this.state.set(indices, playerState);
    });
  }

  public processFrame(frame: FrameEntryType, allFrames: FramesType): void {
    this.playerPermutations.forEach((indices) => {
      const state = this.state.get(indices);
      if (state) {
        handleComboCompute(allFrames, state, indices, frame, this.combos);

        // Emit an event for the new combo
        if (state.event !== null) {
          this.emit(state.event, {
            combo: last(this.combos),
            settings: this.settings,
          });
          state.event = null;
        }
      }
    });
  }

  public fetch(): ComboType[] {
    return this.combos;
  }
}

function handleComboCompute(
  frames: FramesType,
  state: ComboState,
  indices: PlayerIndicesType,
  frame: FrameEntryType,
  combos: ComboType[],
): void {
  const currentFrameNumber = frame.frame;
  const playerFrame = frame.players[indices.playerIndex]!.post;
  // const opponentFrame = frame.players[indices.opponentIndex]!.post;
  // const opponentsFrames = indices.opponentIndices
  //   .filter((index) => frame.players[index] != null)
  //   .map((index) => frame.players[index]!.post);

  const prevFrameNumber = currentFrameNumber - 1;
  let prevPlayerFrame: PostFrameUpdateType;
  let prevOpponentsFrames: PostFrameUpdateType[];

  const prevFrame = frames[prevFrameNumber];

  if (prevFrame) {
    prevPlayerFrame = prevFrame!.players[indices.playerIndex]!.post;
    prevOpponentsFrames = indices.opponentIndices
      .filter((index: number) => prevFrame.players[index] != null)
      .map((index: number) => prevFrame.players[index]!.post);
  } else {
    // TODO: consider this
    return;
  }

  const playerActionStateId = playerFrame.actionStateId!;
  const playerIsDamaged = isDamaged(playerActionStateId);
  const playerIsGrabbed = isGrabbed(playerActionStateId);
  const playerIsCommandGrabbed = isCommandGrabbed(playerActionStateId);
  const playerDamageTaken = prevPlayerFrame ? calcDamageTaken(playerFrame, prevPlayerFrame) : 0;

  // Keep track of whether actionState changes after a hit. Used to compute move count
  // When purely using action state there was a bug where if you did two of the same
  // move really fast (such as ganon's jab), it would count as one move. Added
  // the actionStateCounter at this point which counts the number of frames since
  // an animation started. Should be more robust, for old files it should always be
  // null and null < null = false
  const lastHitByIndex = frame.players[indices.playerIndex]!.post.lastHitBy!;
  if (lastHitByIndex == null || frame.players[lastHitByIndex] == null) {
    state.lastHitAnimation = null;
  } else {
    const lastAttackerFrame = frame.players[lastHitByIndex]!.post;
    const lastAttackerPrevFrame = prevFrame.players[lastHitByIndex]!.post;
    const actionChangedSinceHit = lastAttackerFrame.actionStateId !== state.lastHitAnimation;
    const actionCounter = lastAttackerFrame.actionStateCounter!;
    const prevActionCounter = lastAttackerPrevFrame ? lastAttackerPrevFrame.actionStateCounter! : 0;
    const actionFrameCounterReset = actionCounter < prevActionCounter;
    if (actionChangedSinceHit || actionFrameCounterReset) {
      state.lastHitAnimation = null;
    }
  }

  // If player took damage and was put in some kind of stun this frame, either
  // start a combo or count the moves for the existing combo
  if (playerIsDamaged || playerIsGrabbed || playerIsCommandGrabbed) {
    let comboStarted = false;
    if (!state.combo) {
      state.combo = {
        playerIndex: indices.playerIndex,
        startFrame: currentFrameNumber,
        endFrame: null,
        startPercent: prevPlayerFrame ? prevPlayerFrame.percent ?? 0 : 0,
        currentPercent: prevPlayerFrame.percent ?? 0,
        endPercent: null,
        moves: [],
        didKill: false,
        lastHitBy: lastHitByIndex,
      };

      combos.push(state.combo);

      // Track whether this is a new combo or not
      comboStarted = true;
    }

    if (playerDamageTaken) {
      // If animation of last hit has been cleared that means this is a new move. This
      // prevents counting multiple hits from the same move such as fox's drill

      if (state.lastHitAnimation === null) {
        const lastHitByIndex = frame.players[indices.playerIndex]!.post.lastHitBy!;

        const lastHitBy = frame.players[lastHitByIndex]
          ? frame.players[lastHitByIndex]!.post
          : frame.players[indices.playerIndex]!.post; // no idea what to do in this case
        state.move = {
          playerIndex: lastHitByIndex,
          frame: currentFrameNumber,
          moveId: lastHitBy.lastAttackLanded!,
          hitCount: 0,
          damage: 0,
        };

        state.combo.moves.push(state.move);

        // Make sure we don't overwrite the START event
        if (!comboStarted) {
          state.event = ComboEvent.COMBO_EXTEND;
        }
      }

      if (state.move) {
        state.move.hitCount += 1;
        state.move.damage += playerDamageTaken;
      }

      // Store previous frame animation to consider the case of a trade, the previous
      // frame should always be the move that actually connected... I hope
      const lastHitByPrevFrame = prevFrame.players[lastHitByIndex!]?.post;
      state.lastHitAnimation = lastHitByPrevFrame ? lastHitByPrevFrame.actionStateId : null;
    }

    if (comboStarted) {
      state.event = ComboEvent.COMBO_START;
    }
  }

  if (!state.combo) {
    // The rest of the function handles combo termination logic, so if we don't
    // have a combo started, there is no need to continue
    return;
  }

  const playerIsTeching = isTeching(playerActionStateId);
  const playerIsDowned = isDown(playerActionStateId);
  const playerDidLoseStock = prevOpponentsFrames && didLoseStock(playerFrame, prevPlayerFrame);
  const playerIsDying = isDead(playerActionStateId);

  // Update percent if opponent didn't lose stock
  if (!playerDidLoseStock) {
    state.combo.currentPercent = playerFrame.percent ?? 0;
  }

  if (
    playerIsDamaged ||
    playerIsGrabbed ||
    playerIsCommandGrabbed ||
    playerIsTeching ||
    playerIsDowned ||
    playerIsDying
  ) {
    // If opponent got grabbed or damaged, reset the reset counter
    state.resetCounter = 0;
  } else {
    state.resetCounter += 1;
  }

  let shouldTerminate = false;

  // Termination condition 1 - player kills opponent
  if (playerDidLoseStock) {
    state.combo.didKill = true;
    shouldTerminate = true;
  }

  // Termination condition 2 - combo resets on time
  if (state.resetCounter > Timers.COMBO_STRING_RESET_FRAMES) {
    shouldTerminate = true;
  }

  // If combo should terminate, mark the end states and add it to list
  if (shouldTerminate) {
    state.combo.endFrame = playerFrame.frame;
    state.combo.endPercent = prevPlayerFrame ? prevPlayerFrame.percent ?? 0 : 0;
    state.event = ComboEvent.COMBO_END;

    state.combo = null;
    state.move = null;
  }
}
