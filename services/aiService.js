// 3. 메인 서비스 파일
// - API 호출과 점수 계산 로직을 import
require('dotenv').config();

// 분리된 모듈 import
const { getComplexityScore, getSpectrumScore } = require('./scoringService');
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
        const spectrumScores = await Promise.all(
            finalResults.map(res =>
                res.translated_text 
                ? getSpectrumScore(textToTranslate, res.translated_text, selected_domain) 
                : Promise.resolve(null)
            )
        );
        finalResults = finalResults.map((res, i) => ({ ...res, spectrum_score: spectrumScores[i] }));
    }

    logger.info(`[AI 서비스] 완료. 총 ${finalResults.length}개 결과 반환.`);
    return finalResults;
}

module.exports = { runAnalysis };
