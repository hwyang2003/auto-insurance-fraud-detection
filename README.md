# [ITE 351] Group Project Proposal

## Task 1: Team Members

- Member 1: [김일], [정보시스템학과 /한양대학교], [kimyir2@gmail.com]
- Member 2: [양희원], [정보시스템학과 /한양대학교], [hwyang0627@gmail.com]
- Member 3: [정남주], [정보시스템학과 /한양대학교], namjoo2222@naver.com,
- Member 4: [정진규], [사회학과 /한양대학교], [jjg2035@naver.com]

---

## Task 3: Research Proposal

### Title:

**Predictive Analytics for Auto Insurance Fraud Detection: A Machine Learning Benchmark and Resource Optimization Study**

### Proposal:

This project builds a step-by-step machine learning pipeline for detecting auto insurance fraud using Kaggle's dataset (Option A). Beyond standard model benchmarking, we extend our study to resource-constrained investigation optimization. Following preprocessing—including missing value imputation, feature scaling, and categorical encoding—we train and evaluate multiple classification models (SVC, Random Forest, XGBoost, LightGBM, etc.) using precision, recall, and F1-score. Crucially, we utilize model-predicted risk scores to evaluate top-K% priority inspection strategies (e.g., top 5%, 10%, 20%), comparing cumulative gain curves against a random sampling baseline. Furthermore, we analyze how different missing-value handling methods affect false positive rates. This research offers a practical, decision-centric framework to optimize fraud detection under real-world operational constraints.