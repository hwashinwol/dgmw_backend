// 3. 메인 서비스 파일
// - API 호출과 점수 계산 로직을 import
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
 * 7️⃣ 전체 실행 (Orchestration)
 * - 등급과 분야에 따라 API 호출과 점수 계산을 조율
 */
async function runAnalysis(textToTranslate, userStatus = 'free', selected_domain = 'NULL') {
    logger.info(`[AI 서비스] 번역 시작... (등급: ${userStatus}, 분야: ${selected_domain})`);

    const translationPromises =
        userStatus === 'paid'
            ? [
                callOpenAI('gpt-4o', textToTranslate), 
                callGoogle(textToTranslate), 
                callAnthropic(textToTranslate)
              ]
            : [
                callOpenAI('gpt-3.5-turbo', textToTranslate),
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
        // 1. API 호출에 성공한 결과만 필터링합니다.
        const successfulResults = finalResults.filter(r => !r.error);

        if (successfulResults.length > 0) {
            // 2. 3개의 번역문을 '1번의' API 호출로 평가합니다.
            logger.info(`[AI 서비스] Batch Spectrum Score 평가 시작... (모델 ${successfulResults.length}개)`);
            const batchScoreObjects = await getSpectrumScores_Batch(
                textToTranslate, 
                successfulResults, 
                selected_domain
            );
            // (결과 예: [{ model_name: 'gpt-4o', spectrum_score: 2.0 }, ...])

            // 3. 빠른 조회를 위해 점수 맵(Map)을 생성합니다.
            const scoreMap = new Map(
                batchScoreObjects.map(s => [s.model_name, s.spectrum_score])
            );

            // 4. finalResults에 스펙트럼 점수를 병합합니다.
            finalResults = finalResults.map(res => {
                if (res.error) return res; // 에러난 결과는 그대로 반환
                return {
                    ...res,
                    // 맵에서 모델 이름으로 점수를 찾아 할당합니다.
                    spectrum_score: scoreMap.get(res.model_name) || null 
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
