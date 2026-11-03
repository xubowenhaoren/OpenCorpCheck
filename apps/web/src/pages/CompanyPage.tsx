import { useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getCompanyCard, getCompanyFinancials } from "../api";
import { CompanyFinancials } from "../components/CompanyFinancials";
import { CompanyFilings } from "../components/CompanyFilings";
import { CompanyGraph } from "../components/CompanyGraph";
import { CompanyHeader } from "../components/CompanyHeader";
import { CompanyNews } from "../components/CompanyNews";
import { CompanyOverview } from "../components/CompanyOverview";
import { CompanySources } from "../components/CompanySources";
import { CompanyStub } from "../components/CompanyStub";
import {
  CompanyTabs,
  type CompanyTab,
} from "../components/CompanyTabs";
import { ErrorView, Loading } from "../components/States";
import { addRecent } from "../lib/recent";

const TABS: CompanyTab[] = [
  "overview",
  "financials",
  "graph",
  "news",
  "filings",
  "sources",
];

export function CompanyPage() {
  const { ref, tab } = useParams<{ ref: string; tab?: string }>();
  const activeTab: CompanyTab = TABS.includes(tab as CompanyTab)
    ? (tab as CompanyTab)
    : "overview";

  const query = useQuery({
    queryKey: ["company", ref],
    queryFn: () =>
      getCompanyCard(ref ?? "", {
        include: "facts,relations,events,filings",
      }),
    enabled: Boolean(ref),
    // A queued/active daily filing check is short; poll until the card sees
    // the new cursor, then stop and rely on normal cache behaviour.
    refetchInterval: (state) =>
      state.state.data?.data.filingRefresh?.pending ? 15_000 : false,
  });

  const queryClient = useQueryClient();
  const checkedAtRef = useRef<string | null | undefined>(undefined);
  const lastCheckedAt = query.data?.data.filingRefresh?.lastCheckedAt ?? null;

  // When the daily check advances, the separate statement query is stale too.
  useEffect(() => {
    if (checkedAtRef.current === undefined) {
      checkedAtRef.current = lastCheckedAt;
      return;
    }
    if (lastCheckedAt && lastCheckedAt !== checkedAtRef.current) {
      checkedAtRef.current = lastCheckedAt;
      void queryClient.invalidateQueries({
        queryKey: ["company", ref, "financials"],
      });
    }
  }, [lastCheckedAt, queryClient, ref]);

  // Statements are fetched per period kind so a full EDGAR/F10 statement is
  // never cut off by the card's 200-row cap.
  const financialsQuery = useQuery({
    queryKey: ["company", ref, "financials"],
    queryFn: () => getCompanyFinancials(ref ?? ""),
    enabled: Boolean(ref),
  });

  const card = useMemo(() => {
    const data = query.data?.data;
    if (!data) return undefined;
    return { ...data, financials: financialsQuery.data ?? [] };
  }, [query.data, financialsQuery.data]);

  useEffect(() => {
    if (!card) return;
    addRecent({
      ref: card.company.slug,
      name: card.company.displayName,
      ticker: card.company.tickers[0]?.ticker,
    });
  }, [card?.company.id]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [ref]);

  const sourceCount = useMemo(() => {
    if (!card) return 0;
    const urls = new Set<string>();
    for (const fact of card.financials ?? []) {
      if (fact.source?.url) urls.add(fact.source.url);
    }
    for (const fact of card.facts ?? []) {
      if (fact.source?.url) urls.add(fact.source.url);
    }
    for (const event of card.events ?? []) {
      if (event.source?.url) urls.add(event.source.url);
    }
    for (const filing of card.filings ?? []) {
      if (filing.source?.url) urls.add(filing.source.url);
    }
    for (const relation of [
      ...(card.relations?.incoming ?? []),
      ...(card.relations?.outgoing ?? []),
    ]) {
      for (const evidence of relation.evidence) {
        if (evidence.url) urls.add(evidence.url);
      }
    }
    return urls.size;
  }, [card]);

  if (query.isLoading || financialsQuery.isLoading) return <Loading />;
  if (query.isError || financialsQuery.isError || !card) {
    const error = query.error ?? financialsQuery.error;
    return (
      <ErrorView
        message={error instanceof Error ? error.message : undefined}
        code={
          error instanceof Error && "code" in error
            ? String((error as { code?: string }).code ?? "")
            : undefined
        }
        onRetry={() => {
          void query.refetch();
          void financialsQuery.refetch();
        }}
      />
    );
  }

  const relations =
    (card.counts?.relationsOutgoing ?? 0) +
    (card.counts?.relationsIncoming ?? 0);

  if (card.company.coverageTier === "stub") {
    return <CompanyStub company={card.company} />;
  }

  return (
    <>
      <CompanyHeader
        company={card.company}
        facts={card.facts ?? []}
        events={card.events ?? []}
      />
      <CompanyTabs
        companyRef={card.company.slug}
        active={activeTab}
        counts={{
          financials: card.financials?.length ?? 0,
          relations,
          events: card.events?.length ?? 0,
          filings: card.filings?.length ?? 0,
          sources: sourceCount,
        }}
      />

      <section className="panel">
        {activeTab === "overview" ? <CompanyOverview card={card} /> : null}
        {activeTab === "financials" ? (
          <CompanyFinancials
            financials={card.financials ?? []}
            company={card.company}
            filingRefresh={card.filingRefresh}
          />
        ) : null}
        {activeTab === "graph" ? (
          <CompanyGraph
            companyRef={card.company.slug}
            companyName={card.company.displayName}
            companySlug={card.company.slug}
          />
        ) : null}
        {activeTab === "news" ? (
          <CompanyNews events={card.events ?? []} company={card.company} />
        ) : null}
        {activeTab === "filings" ? (
          <CompanyFilings
            filings={card.filings ?? []}
            company={card.company}
            refresh={card.filingRefresh}
          />
        ) : null}
        {activeTab === "sources" ? <CompanySources card={card} /> : null}
      </section>
    </>
  );
}
