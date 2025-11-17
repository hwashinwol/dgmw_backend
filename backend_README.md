# DGMW (그런 뜻 아닌데): AI 번역 스타일 분석기 (Backend)

> AI 번역 모델(GPT-4o, Gemini, Claude)의 번역 결과를 비교하고, '직역'부터 '의역'까지의 번역 스타일(Spectrum)을 AI로 분석해 주는 웹 서비스입니다.

이 레포지토리는 DGMW 프로젝트의 백엔드(Node.js / Express) 서버입니다.
[프론트엔드 레포지토리 바로가기](https://github.com/hwashinwol/dgmw_frontend)

## 1. 핵심 기능 (Features)

1. 다중 AI 모델 번역: GPT-4o, Gemini 2.5 Flash, Claude Sonnet 4.5 등 최신 LLM의 번역 결과를 한눈에 비교합니다.
2. AI 번역 스타일 분석: GPT-4o가 원문과 번역문을 비교하여 '스펙트럼 점수(1.0~10.0)'와 피드백을 생성합니다.
3. 전문 분야 번역: '법률', '의료', '문학' 등 전문 분야를 선택하면, `domainRulesMap`에 정의된 규칙에 따라 AI 프롬프트가 최적화됩니다.
4. 파일 번역: 텍스트 입력뿐만 아니라 PDF, DOCX, TXT 파일 업로드를 지원합니다.
5. 구독 및 결제: Stripe API를 연동하여 'free' 등급(일 5회)과 'paid' 등급(파일 업로드, 전문 분야 번역)을 구분하는 사용자 시스템을 구현했습니다.
6. 사용자 인증: JWT(JSON Web Token)를 사용한 회원가입 및 로그인 기능을 제공합니다.


## 2. 기술 스택 (Tech Stack)

| 구분 | 기술 | 주요 역할 |
| :--- | :--- | :--- |
| **Frontend** | React, Axios, React Router | UI/UX 구축, API 비동기 통신, 페이지 라우팅 |
| **Backend** | Node.js, Express.js | RESTful API 서버 구축, 비즈니스 로직 처리 |
| **Database** | MySQL (with `mysql2/promise`) | 사용자 정보, 번역 작업(Job), 분석 결과 저장 |
| **AI (Translate)** | OpenAI (GPT-4o/3.5T), Google (Gemini), Anthropic (Claude) | 핵심 다중 번역 엔진 |
| **AI (Analyze)** | OpenAI (GPT-4o) | **[핵심]** 직역/의역 스펙트럼 점수 및 피드백 생성 |
| **Payments** | Stripe API | 'free' / 'paid' 등급 관리를 위한 구독 결제 |
| **Auth** | JWT (JSON Web Token) | 사용자 로그인 및 API 접근 권한 인증 |
| **File Storage** | NCP Object Storage (S3 호환) | 업로드된 원본 파일 및 대용량 번역 결과 저장 |
| **File Parsing** | `pdf-parse`, `mammoth` | PDF, DOCX 파일에서 텍스트 추출 |
| **Utils** | `winston` (logger) | 서버 로그 관리 및 디버깅 |

## 3. 설치 및 실행 (Getting Started)

이 프로젝트는 백엔드와 프론트엔드 레포지토리가 분리되어 있습니다.
[프론트엔드 레포지토리 바로가기](https://github.com/hwashinwol/dgmw_frontend)

## 4. 시스템 아키텍쳐
%% `graph TD`는 Top-Down (위에서 아래로) 방향의 다이어그램을 의미합니다.
graph TD
    
    subgraph "사용자 영역 (Client)"
        User[사용자 (Browser)]
    end

    subgraph "프론트엔드 (Vercel / Netlify)"
        FE[React App<br>(AuthContext, /translate, /mypage)]
    end

    subgraph "백엔드 (AWS / GCP / Heroku)"
        API[Node.js / Express API<br>(/api/v1/...)]
        DB[(MariaDB / MySQL<br>Users, Jobs, Results)]
    end

    subgraph "외부 서비스 (3rd Party APIs)"
        Google[Google OAuth<br>(로그인 인증)]
        Stripe[Stripe<br>(결제 처리)]
        NCP[NCP Object Storage<br>(파일 입/출력 저장)]
        
        Gemini[Gemini 2.5 Flash<br>(AI 번역)]
        GoogleNMT[Google Translation<br>(기계 번역)]
        OpenAI35[ChatGPT-3.5<br>(AI 번역)]
        OpenAI4o[ChatGPT-4o<br>(AI 번역/분석)]
        Anthropic[Claude Sonnet 4.5<br>(AI 번역)]
    end

    %% 화살표 (데이터 흐름)
    User -- "1. 웹사이트 접속" --> FE

    FE -- "2. API 요청 (JWT 포함)<br> (e.g., /translate, /user/me)" --> API

    API -- "3. 유저/작업/결과 저장" --> DB
    API -- "4. 구글 로그인/인증" --> Google
    API -- "5. 결제 세션/웹훅" --> Stripe
    API -- "6. 파일(입/출력) 저장" --> NCP
    
    %% --- 수정된 AI 요청 화살표 (각 모델 ID에 연결) ---
    API -- "7. 번역/분석 요청" --> Gemini
    API -- "7. 번역/분석 요청" --> GoogleNMT
    API -- "7. 번역/분석 요청" --> OpenAI35
    API -- "7. 번역/분석 요청" --> OpenAI4o
    API -- "7. 번역/분석 요청" --> Anthropic

### 1. 백엔드 서버 실행 (Current Repo)

1. 현재 레포지토리 클론 및 설치
```bash
$git clone [https://github.com/hwashinwol/dgmw_backend.git$](https://github.com/hwashinwol/dgmw_backend.git$) cd dgmw_backend
$ npm install

2. .env 파일 설정
루트 디렉토리에 .env 파일을 생성하고 아래 환경 변수를 설정합니다.
# DB
DB_HOST=...
DB_USER=...
DB_PASSWORD=...
DB_DATABASE=...

# APIs
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
ANTHROPIC_API_KEY=...

# Auth
JWT_SECRET=...

# Payments
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...

# File Storage (NCP)
NCP_ENDPOINT=...
NCP_REGION=...
NCP_BUCKET_NAME=...
NCP_ACCESS_KEY=...
NCP_SECRET_KEY=...

3. DB 스키마 적용
(프로젝트에 포함된 schema.sql 파일을 MySQL DB에 실행합니다.)

4. 백엔드 서버 시작
$ npm start  # (서버가 8080 포트에서 실행됩니다)


### 2. 프론트엔드 서버 실행 
프론트엔드 서버는 별도의 레포지토리에서 실행해야 합니다.

1. 프론트엔드 레포지토리 클론 및 설치
(별도의 터미널을 열고 실행합니다)
$git clone [https://github.com/hwashinwol/dgmw_frontend.git$](https://github.com/hwashinwol/dgmw_frontend.git$) cd dgmw_frontend
$ npm install

2. .env 파일 설정
루트 디렉토리에 .env 파일을 생성하고 아래 환경 변수를 설정합니다.
# 백엔드 API 서버 주소 (먼저 실행한 서버)
REACT_APP_API_URL=http://localhost:8080

# Stripe 공개 키
REACT_APP_STRIPE_PUBLIC_KEY=pk_test_...

3. 프론트엔드 서버 시작
$ npm start # (클라이언트가 3000 포트에서 실행됩니다)

