import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useState } from "react";
import type { Question } from "../../tools/AskUserQuestionTool/AskUserQuestionTool.js";
import { questionService, type QuestionRequest } from "../../services/question/questionService.js";
import { useMultipleChoiceState } from "../permissions/AskUserQuestionPermissionRequest/use-multiple-choice-state.js";
import { QuestionView } from "../permissions/AskUserQuestionPermissionRequest/QuestionView.js";
import { SubmitQuestionsView } from "../permissions/AskUserQuestionPermissionRequest/SubmitQuestionsView.js";
import { useRegisterOverlay } from "../../context/overlayContext.js";
import { useKeybindings } from "../../keybindings/useKeybinding.js";
import type { PermissionDecision } from "../../utils/permissions/PermissionResult.js";

const NO_PERMISSION: PermissionDecision = { behavior: "allow" } as PermissionDecision;

type Props = {
  request: QuestionRequest;
  onResolved: () => void;
};

/**
 * Standalone question overlay (decoupled from the permission system).
 * Renders the same choice UI as AskUserQuestion but resolves the
 * questionService pending request on reply/reject.
 */
export function QuestionPrompt(props: Props) {
  const $ = _c(40);
  const { request, onResolved } = props;
  const questions = request.questions as unknown as Question[];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const state = useMultipleChoiceState();
  const {
    currentQuestionIndex,
    questionStates,
    isInTextInput,
    nextQuestion,
    prevQuestion,
    updateQuestionState,
    setAnswer,
    setTextInputMode,
  } = state;
  const currentQuestion =
    currentQuestionIndex < questions.length ? questions[currentQuestionIndex] : null;
  const isInSubmitView = currentQuestionIndex === questions.length;
  const allQuestionsAnswered = questions.every(q => q?.question && !!answers[q.question]);
  const hideSubmitTab = questions.length === 1 && !questions[0]?.multiSelect;
  const maxIndex = hideSubmitTab ? questions.length - 1 : questions.length;
  useRegisterOverlay("question", true);
  let t0;
  if ($[0] !== answers || $[1] !== questions) {
    t0 = questions.every(q_0 => q_0?.question && !!answers[q_0.question]) ?? false;
    $[0] = answers;
    $[1] = questions;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== answers) {
    t1 = (q_1: string, a: string | string[], textInput?: string, shouldAdvance?: boolean) => {
      const isMulti = Array.isArray(a);
      const value = isMulti ? (a as string[]).join(", ") : (a as string);
      const next = { ...answers, [q_1]: value };
      setAnswers(next);
      setAnswer(q_1, value, shouldAdvance);
      if (!isMulti && shouldAdvance !== false && questions.length === 1) {
        void reply([value]);
      }
    };
    $[3] = answers;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleAnswer = t1;
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = (q_2: string) => {
      const next = { ...answers };
      delete next[q_2];
      setAnswers(next);
    };
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  const handleCancel = t2;
  let t3;
  if ($[6] !== answers || $[7] !== questions) {
    t3 = (final: "submit" | "cancel") => {
      if (final === "cancel") {
        handleCancelReply();
        return;
      }
      const result = questions.map(q_3 => {
        const a = answers[q_3.question];
        return a ? (q_3.multiSelect ? a.split(", ") : [a]) : [];
      });
      void reply(result);
    };
    $[6] = answers;
    $[7] = questions;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  const handleFinal = t3;
  let t4;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = () => {
      questionService.reject(request.id);
      onResolved();
    };
    $[9] = t4;
  } else {
    t4 = $[9];
  }
  const handleCancelReply = t4;
  let t5;
  if ($[10] !== answers || $[11] !== questions) {
    t5 = async (result: string[][]) => {
      questionService.reply({ requestID: request.id, answers: result });
      onResolved();
    };
    $[10] = answers;
    $[11] = questions;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  const reply = t5;
  let t6;
  if ($[13] !== currentQuestionIndex || $[14] !== maxIndex || $[15] !== nextQuestion) {
    t6 = () => {
      if (currentQuestionIndex < maxIndex) nextQuestion();
    };
    $[13] = currentQuestionIndex;
    $[14] = maxIndex;
    $[15] = nextQuestion;
    $[16] = t6;
  } else {
    t6 = $[16];
  }
  const handleTabNext = t6;
  let t7;
  if ($[17] !== currentQuestionIndex || $[18] !== prevQuestion) {
    t7 = () => {
      if (currentQuestionIndex > 0) prevQuestion();
    };
    $[17] = currentQuestionIndex;
    $[18] = prevQuestion;
    $[19] = t7;
  } else {
    t7 = $[19];
  }
  const handleTabPrev = t7;
  useKeybindings(
    { "tabs:previous": handleTabPrev, "tabs:next": handleTabNext },
    { context: "Tabs", isActive: !(isInTextInput && !isInSubmitView) },
  );
  if (currentQuestion) {
    let t8;
    if (
      $[20] !== answers ||
      $[21] !== currentQuestion ||
      $[22] !== currentQuestionIndex ||
      $[23] !== handleAnswer ||
      $[24] !== handleCancel ||
      $[25] !== handleTabNext ||
      $[26] !== handleTabPrev ||
      $[27] !== hideSubmitTab ||
      $[28] !== nextQuestion ||
      $[29] !== questions ||
      $[30] !== questionStates ||
      $[31] !== setTextInputMode ||
      $[32] !== updateQuestionState
    ) {
      t8 = (
        <QuestionView
          question={currentQuestion}
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          questionStates={questionStates}
          hideSubmitTab={hideSubmitTab}
          onUpdateQuestionState={updateQuestionState}
          onAnswer={handleAnswer}
          onTextInputFocus={setTextInputMode}
          onCancel={handleCancelReply}
          onSubmit={nextQuestion}
          onTabPrev={handleTabPrev}
          onTabNext={handleTabNext}
          onRespondToClaude={handleCancelReply}
          onFinishPlanInterview={handleCancelReply}
        />
      );
      $[20] = answers;
      $[21] = currentQuestion;
      $[22] = currentQuestionIndex;
      $[23] = handleAnswer;
      $[24] = handleCancel;
      $[25] = handleTabNext;
      $[26] = handleTabPrev;
      $[27] = hideSubmitTab;
      $[28] = nextQuestion;
      $[29] = questions;
      $[30] = questionStates;
      $[31] = setTextInputMode;
      $[32] = updateQuestionState;
      $[33] = t8;
    } else {
      t8 = $[33];
    }
    return t8;
  }
  if (isInSubmitView) {
    let t9;
    if (
      $[34] !== allQuestionsAnswered ||
      $[35] !== answers ||
      $[36] !== currentQuestionIndex ||
      $[37] !== questions ||
      $[38] !== handleFinal
    ) {
      t9 = (
        <SubmitQuestionsView
          questions={questions}
          currentQuestionIndex={currentQuestionIndex}
          answers={answers}
          allQuestionsAnswered={allQuestionsAnswered}
          permissionResult={NO_PERMISSION}
          onFinalResponse={handleFinal}
        />
      );
      $[34] = allQuestionsAnswered;
      $[35] = answers;
      $[36] = currentQuestionIndex;
      $[37] = questions;
      $[38] = handleFinal;
      $[39] = t9;
    } else {
      t9 = $[39];
    }
    return t9;
  }
  return null;
}
