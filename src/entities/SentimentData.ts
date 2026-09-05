import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * SentimentData Entity
 * Stores sentiment analysis data from news, social media, and analyst ratings
 * Used for ML feature engineering and sentiment analysis
 */
@Entity("sentiment_data")
@Index(["ticker", "date"], { unique: true })
export class SentimentData {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 20 })
  @Index()
  ticker!: string;

  @Column({ type: "date" })
  @Index()
  date!: Date;

  // News Sentiment
  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  newsSentiment!: number; // 0-100 score (0=very negative, 50=neutral, 100=very positive)

  @Column({ type: "integer", default: 0 })
  newsArticleCount!: number;

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  newsSentimentChange?: number; // 7-day change in sentiment

  // Social Media Sentiment
  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  socialSentiment!: number; // 0-100 score

  @Column({ type: "integer", default: 0 })
  socialMentionCount!: number;

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  socialSentimentChange?: number; // 7-day change

  // Reddit Sentiment (specific to Reddit data)
  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  redditSentiment!: number;

  @Column({ type: "integer", default: 0 })
  redditMentions!: number;

  // Twitter/X Sentiment
  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  twitterSentiment!: number;

  @Column({ type: "integer", default: 0 })
  twitterMentions!: number;

  // Analyst Ratings
  @Column({ type: "integer", default: 0 })
  analystBuyRatings!: number;

  @Column({ type: "integer", default: 0 })
  analystHoldRatings!: number;

  @Column({ type: "integer", default: 0 })
  analystSellRatings!: number;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  analystConsensus!: number; // 0-100 (weighted toward buy)

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  analystTargetPrice?: number;

  // Insider Trading
  @Column({ type: "integer", default: 0 })
  insiderBuyCount!: number; // Number of insider purchases in last 30 days

  @Column({ type: "integer", default: 0 })
  insiderSellCount!: number; // Number of insider sales in last 30 days

  @Column({ type: "bigint", default: 0 })
  insiderBuyValue!: number; // Total value of insider purchases

  @Column({ type: "bigint", default: 0 })
  insiderSellValue!: number; // Total value of insider sales

  // Composite Scores
  @Column({ type: "decimal", precision: 5, scale: 2, default: 50 })
  compositeSentiment!: number; // Weighted average of all sentiment sources

  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  sentimentVolatility!: number; // Standard deviation of sentiment over 30 days

  @Column({ type: "varchar", length: 20, default: "neutral" })
  sentimentTrend!: string; // 'improving', 'neutral', 'declining'

  // Metadata
  @Column({ type: "jsonb", nullable: true })
  topKeywords?: string[]; // Top mentioned keywords/phrases

  @Column({ type: "jsonb", nullable: true })
  sentimentBreakdown?: {
    positive: number;
    neutral: number;
    negative: number;
  };

  @Column({ type: "varchar", length: 100, default: "multi-source" })
  dataSource!: string;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 100 })
  dataQuality!: number; // 0-100 percentage of fields populated

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
