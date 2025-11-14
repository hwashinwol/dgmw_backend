require('dotenv').config();

// 분리된 모듈 import
const { getComplexityScore, getSpectrumScores_Batch } = require('./scoringService');
const { 
    callOpenAI, 
    callGoogle, 
    callAnthropic, 
    callGoogleTranslate
} = require('./translatorFactory');
const logger = require('../utils/logger');

/**
 * 전체 실행 (Orchestration)
 */
async function runAnalysis(textToTranslate, userStatus = 'free', selected_domain = 'NULL') {
    logger.info(`[AI 서비스] 번역 시작... (등급: ${userStatus}, 분야: ${selected_domain})`);

    const translationPromises =
        userStatus === 'paid'
            ? [
                callOpenAI('gpt-4o', textToTranslate, selected_domain), 
                callGoogle(textToTranslate, selected_domain), 
                callAnthropic(textToTranslate, selected_domain)
              ]
            : [
                callOpenAI('gpt-3.5-turbo',textToTranslate, selected_domain), 
                callGoogleTranslate(textToTranslate)
              ];

    const initialResults = await Promise.all(translationPromises);
    let finalResults = [];

    for (const res of initialResults) {
        if (res.error) {
            finalResults.push({ ...res, complexity_score: null, spectrum_score: null });
            continue;
        }
        finalResults.push({
            ...res,
            complexity_score: getComplexityScore(res.translated_text), 
            spectrum_score: null
        });
    }

    if (userStatus === 'paid') {
        const successfulResults = finalResults.filter(r => !r.error);

        if (successfulResults.length > 0) {
            // 3개의 번역문을 API 호출로 한 번만 하여 평가
            logger.info(`[AI 서비스] Batch Spectrum Score 평가 시작... (모델 ${successfulResults.length}개)`);
            const batchScoreObjects = await getSpectrumScores_Batch(
                textToTranslate, 
                successfulResults, 
                selected_domain
            );

            // 점수 맵 생성
            const scoreMap = new Map(
                batchScoreObjects.map(s => [s.model_name, { 
                    spectrum_score: s.spectrum_score, 
                    spectrum_feedback: s.spectrum_feedback 
                }])
            );

            // 4. finalResults에 스펙트럼 점수를 병합합니다.
            finalResults = finalResults.map(res => {
                if (res.error) return res;
                const scoreData = scoreMap.get(res.model_name);

                return {
                    ...res,
                    spectrum_score: scoreData?.spectrum_score ?? null,
                    spectrum_feedback: scoreData?.spectrum_feedback ?? null
                };
            });
        
        } else {
            logger.warn("[AI 서비스] 모든 유료 번역 API 호출에 실패하여 Spectrum Score 평가를 건너뜁니다.");
        }
    }

    logger.info(`[AI 서비스] 완료. 총 ${finalResults.length}개 결과 반환.`);
    return finalResults;
}

module.exports = { runAnalysis };
