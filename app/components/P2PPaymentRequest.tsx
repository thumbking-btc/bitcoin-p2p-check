"use client";

import { useState } from "react";

import { P2PLightningRequest } from "./P2PLightningRequest";
import { P2PReceiveRequest } from "./P2PReceiveRequest";

type TransferSupport = "onchain" | "lightning" | "both";
type PaymentRail = Exclude<TransferSupport, "both">;

type Props = {
  fundingSource: string;
  isBuyer: boolean;
  paymentKrw: number | null;
  quoteCurrent: boolean;
  quoteKey: string;
  referenceTime: string | null;
  sats: number | null;
  transferSupport: TransferSupport;
};

function railAvailable(support: TransferSupport, rail: PaymentRail) {
  return support === "both" || support === rail;
}

export function P2PPaymentRequest(props: Props) {
  const [rail, setRail] = useState<PaymentRail | null>(null);
  const onchainAvailable = railAvailable(props.transferSupport, "onchain");
  const lightningAvailable = railAvailable(props.transferSupport, "lightning");

  if (!props.isBuyer) {
    return (
      <section className="receive-request payment-request-shell" aria-labelledby="payment-request-title">
        <header>
          <div>
            <p className="section-kicker">DM에서 실제 요청</p>
            <h2 id="payment-request-title">BTC 송금 요청</h2>
          </div>
          <span>구매자가 준비</span>
        </header>
        <div className="receive-request-empty">
          <strong>구매자가 자신의 지갑에서 1:1 요청을 준비합니다.</strong>
          <p>판매자는 공개 모집물만 보고 보내지 말고, 구매자가 합의한 방식으로 만든 주소나 인보이스의 전체 금액을 별도 채널에서 다시 확인하세요.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="payment-request-shell" aria-labelledby="payment-method-title">
      <header className="payment-method-header">
        <div>
          <p className="section-kicker">DM에서 실제 요청</p>
          <h2 id="payment-method-title">BTC 받을 방법 선택</h2>
        </div>
        <span>한 번에 한 방식</span>
      </header>
      <fieldset className="payment-rail-fieldset">
        <legend>이번 거래에 실제로 사용할 방법을 선택하세요.</legend>
        <div className="payment-rail-options">
          <label htmlFor="payment-request-onchain" aria-label={`온체인으로 받기. ${onchainAvailable ? "새 주소와 블록 확인을 사용합니다." : "이번 모집에서 미지원입니다."}`}>
            <input
              id="payment-request-onchain"
              type="radio"
              name="payment-request-rail"
              checked={rail === "onchain"}
              disabled={!onchainAvailable}
              onChange={() => setRail("onchain")}
            />
            <span><b>온체인</b><small>{onchainAvailable ? "새 주소 · 블록 확인" : "이번 모집에서 미지원"}</small></span>
          </label>
          <label htmlFor="payment-request-lightning" aria-label={`라이트닝으로 받기. ${lightningAvailable ? "1회용 인보이스와 만료를 사용합니다." : "이번 모집에서 미지원입니다."}`}>
            <input
              id="payment-request-lightning"
              type="radio"
              name="payment-request-rail"
              checked={rail === "lightning"}
              disabled={!lightningAvailable}
              onChange={() => setRail("lightning")}
            />
            <span><b>라이트닝</b><small>{lightningAvailable ? "1회용 인보이스 · 만료" : "이번 모집에서 미지원"}</small></span>
          </label>
        </div>
        <p>공개 모집에서 표시한 가능 방식 안에서 선택합니다. 방식을 바꾸면 입력한 주소·인보이스와 QR을 즉시 지우고 다시 시작합니다.</p>
      </fieldset>

      {rail === "onchain" ? (
        <P2PReceiveRequest
          key={`onchain:${props.quoteKey}`}
          isBuyer
          quoteCurrent={props.quoteCurrent}
          quoteKey={props.quoteKey}
          referenceTime={props.referenceTime}
          paymentKrw={props.paymentKrw}
          sats={props.sats}
          fundingSource={props.fundingSource}
        />
      ) : rail === "lightning" ? (
        <P2PLightningRequest
          key={`lightning:${props.quoteKey}`}
          quoteCurrent={props.quoteCurrent}
          quoteKey={props.quoteKey}
          referenceTime={props.referenceTime}
          paymentKrw={props.paymentKrw}
          sats={props.sats}
          fundingSource={props.fundingSource}
        />
      ) : (
        <p className="payment-rail-empty" role="status">받을 방법을 선택하면 10분 고정 조건과 로컬 QR 만들기를 시작할 수 있습니다.</p>
      )}
    </section>
  );
}
