import React, { type ChangeEvent, type FC, type KeyboardEvent, useCallback, useRef } from 'react';
import { enterCommitsSearch } from 'apps/legacy/features/embeddingVideoSearch/submitQuery';
import AlphaPicker from 'components/alphaPicker/AlphaPickerComponent';
import Input from 'elements/emby-input/Input';
import globalize from 'lib/globalize';
import layoutManager from 'components/layoutManager';
import browser from 'scripts/browser';
import 'material-design-icons-iconfont';
import 'styles/flexstyles.scss';
import './searchfields.scss';

interface SearchFieldsProps {
    query: string,
    onSearch?: (query: string) => void
    onSubmit?: (query: string) => void
    submitLabel?: string
}

const SearchFields: FC<SearchFieldsProps> = ({
    onSearch = () => { /* no-op */ },
    onSubmit,
    submitLabel,
    query
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    const onAlphaPicked = useCallback((e: Event) => {
        const value = (e as CustomEvent).detail.value;
        const inputValue = inputRef.current?.value || '';

        if (value === 'backspace') {
            onSearch(inputValue.length ? inputValue.substring(0, inputValue.length - 1) : '');
        } else {
            onSearch(inputValue + value);
        }
    }, [onSearch]);

    const onChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        onSearch(e.target.value);
    }, [ onSearch ]);

    const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
        if (!onSubmit) {
            return;
        }

        const legacy = event.nativeEvent as unknown as { keyCode?: number };
        const keyCode = legacy.keyCode;
        if (!enterCommitsSearch({
            key: event.key,
            isComposing: event.nativeEvent.isComposing,
            keyCode: typeof keyCode === 'number' ? keyCode : undefined
        })) {
            return;
        }

        event.preventDefault();
        onSubmit(event.currentTarget.value);
    }, [onSubmit]);

    const onSubmitClick = useCallback(() => {
        onSubmit?.(inputRef.current?.value ?? query);
    }, [onSubmit, query]);

    return (
        <div className='padded-left padded-right searchFields'>
            <div className='searchFieldsInner flex align-items-center justify-content-center'>
                <span className='searchfields-icon material-icons search' aria-hidden='true' />
                <div
                    className='inputContainer flex-grow'
                    style={{ marginBottom: 0 }}
                >
                    <Input
                        ref={inputRef}
                        id='searchTextInput'
                        className='searchfields-txtSearch'
                        type='text'
                        data-keyboard='true'
                        placeholder={globalize.translate('Search')}
                        autoComplete='off'
                        // eslint-disable-next-line jsx-a11y/no-autofocus
                        autoFocus
                        value={query}
                        onChange={onChange}
                        onKeyDown={onKeyDown}
                    />
                </div>
                {onSubmit && (
                    <button type='button' className='emby-button raised searchfields-submit' onClick={onSubmitClick}>
                        {submitLabel}
                    </button>
                )}
            </div>
            {layoutManager.tv && !browser.tv
                && <AlphaPicker onAlphaPicked={onAlphaPicked} />
            }
        </div>
    );
};

export default SearchFields;
