import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { getCompanyCard } from "../api";
import { CompanyFinancials } from "../components/CompanyFinancials";
import { CompanyGraph } from "../components/CompanyGraph";
import { CompanyHeader } from "../components/CompanyHeader";
import { CompanyNews } from "../components/CompanyNews";
import { CompanyOverview } from "../components/CompanyOverview";
import { CompanySources } from "../components/CompanySources";
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
  "sources",
];

export function CompanyPage() {
  const { ref, tab } = useParams<{ ref: string; tab?: string }>();
  const activeTab: CompanyTab = TABS.includes(tab as CompanyTab)
    ? (tab as CompanyTab)
    : "overview";

  const query = useQuery({
    queryKey: ["company", ref],
    queryFn: () => getCompanyCard(ref ?? ""),
    enabled: Boolean(ref),
  });

  const card = query.data?.data;

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

  if (query.isLoading) return <Loading />;
  if (query.isError || !card) {
    return (
      <ErrorView
        message={
          query.error instanceof Error ? query.error.message : undefined
        }
        code={
          query.error instanceof Error && "code" in query.error
            ? String((query.error as { code?: string }).code ?? "")
            : undefined
        }
        onRetry={() => void query.refetch()}
      />
    );
  }

  const relations =
    (card.counts?.relationsOutgoing ?? 0) +
    (card.counts?.relationsIncoming ?? 0);

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
          sources: sourceCount,
        }}
      />

      <section className="panel">
        {activeTab === "overview" ? <CompanyOverview card={card} /> : null}
        {activeTab === "financials" ? (
          <CompanyFinancials
            financials={card.financials ?? []}
            company={card.company}
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
        {activeTab === "sources" ? <CompanySources card={card} /> : null}
      </section>
    </>
  );
}
