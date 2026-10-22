import type { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import EmbeddingVideoSearchSection from 'apps/legacy/features/embeddingVideoSearch/EmbeddingVideoSearchSection';
import { segmentCopy } from 'apps/legacy/features/embeddingVideoSearch/copy';
import { useSearchItems } from 'apps/legacy/features/search/api/useSearchItems';
import SearchFields from 'apps/legacy/features/search/components/SearchFields';
import SearchResults from 'apps/legacy/features/search/components/SearchResults';
import SearchSuggestions from 'apps/legacy/features/search/components/SearchSuggestions';
import Page from 'components/Page';
import useSearchParam from 'hooks/useSearchParam';
import globalize, { getCurrentLocale } from 'lib/globalize';

const COLLECTION_TYPE_PARAM = 'collectionType';
const PARENT_ID_PARAM = 'parentId';
const QUERY_PARAM = 'query';
const SIMILAR_PARAM = 'similar';

interface NameMatchesProps {
    parentId?: string
    collectionType?: CollectionType
    query: string
    title: string
}

/** Title search stays official, but only takes space when it found something. */
const NameMatches: FC<NameMatchesProps> = ({ parentId, collectionType, query, title }) => {
    const { data, isPending } = useSearchItems(parentId, collectionType, query.trim());
    if (isPending) {
        return null;
    }

    if (!data?.length) {
        if (!collectionType) {
            return null;
        }

        return (
            <p className='evsNameEmpty padded-left padded-right'>
                {globalize.translate('SearchResultsEmpty', query)}{' '}
                <Link className='button-link' to={`/search?query=${encodeURIComponent(query)}`}>
                    {globalize.translate('RetryWithGlobalSearch')}
                </Link>
            </p>
        );
    }

    return (
        <section className='evsNameSearch' aria-labelledby='embedding-name-search-title'>
            <h2 id='embedding-name-search-title' className='sectionTitle sectionTitle-cards padded-left padded-right'>
                {title}
            </h2>
            <SearchResults
                parentId={parentId}
                collectionType={collectionType}
                query={query}
            />
        </section>
    );
};

const Search: FC = () => {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const parentIdQuery = searchParams.get(PARENT_ID_PARAM) || undefined;
    const collectionTypeQuery = (searchParams.get(COLLECTION_TYPE_PARAM) || undefined) as CollectionType | undefined;
    const similarParam = searchParams.get(SIMILAR_PARAM)?.trim() || undefined;
    const [ query ] = useSearchParam(QUERY_PARAM);
    const [ draft, setDraft ] = useState(query);
    const pushedSimilarRef = useRef(false);
    useEffect(() => {
        setDraft(query);
    }, [query]);
    const copy = segmentCopy(getCurrentLocale());
    const onSimilarChange = useCallback((next: string | undefined, history: 'push' | 'replace') => {
        if (history === 'push') {
            pushedSimilarRef.current = true;
        }

        if (!next) {
            pushedSimilarRef.current = false;
        }

        setSearchParams((previous) => {
            const params = new URLSearchParams(previous);
            if (next) {
                params.set(SIMILAR_PARAM, next);
            } else {
                params.delete(SIMILAR_PARAM);
            }

            return params;
        }, { replace: history !== 'push' });
    }, [setSearchParams]);
    const onSimilarBack = useCallback(() => {
        if (pushedSimilarRef.current) {
            pushedSimilarRef.current = false;
            navigate(-1);
            return;
        }

        onSimilarChange(undefined, 'replace');
    }, [navigate, onSimilarChange]);
    const submitSearch = useCallback((value: string) => {
        const submitted = value.trim();
        setDraft(submitted);
        pushedSimilarRef.current = false;
        setSearchParams((previous) => {
            const params = new URLSearchParams(previous);
            if (submitted) {
                params.set(QUERY_PARAM, submitted);
            } else {
                params.delete(QUERY_PARAM);
            }

            params.delete(SIMILAR_PARAM);
            return params;
        }, { replace: true });
    }, [setSearchParams]);

    return (
        <Page
            id='searchPage'
            title={globalize.translate('Search')}
            className='mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage'
        >
            <SearchFields
                query={draft}
                onSearch={setDraft}
                onSubmit={submitSearch}
                submitLabel={copy.searchAction}
            />
            {!query.trim() && !similarParam && (
                <SearchSuggestions
                    parentId={parentIdQuery}
                />
            )}
            <EmbeddingVideoSearchSection
                query={query}
                draft={draft}
                parentId={parentIdQuery}
                similarSegmentId={similarParam}
                onSimilarChange={onSimilarChange}
                onSimilarBack={onSimilarBack}
            />
            {query.trim() && !similarParam && (
                <NameMatches
                    parentId={parentIdQuery}
                    collectionType={collectionTypeQuery}
                    query={query}
                    title={copy.nameSearch}
                />
            )}
        </Page>
    );
};

export default Search;
